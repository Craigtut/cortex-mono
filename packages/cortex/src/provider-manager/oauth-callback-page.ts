/**
 * The OAuth callback page shim: the one process-global patch of
 * `http.ServerResponse.prototype.end` that lets a consumer render pi-ai's
 * localhost callback page and lets a flow observe the callback's outcome,
 * plus the fixed callback routes and the loopback port probe.
 */

import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OAuthError } from './oauth-types.js';
import type {
  OAuthCallbackPageContext,
  OAuthCallbackPageRenderer,
  OAuthCallbackPageStatus,
} from './oauth-types.js';

const nodeRequire = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// OAuth callback page rendering shim
// ---------------------------------------------------------------------------

/**
 * A provider's fixed loopback OAuth callback route. In production these are the
 * real ports pi-ai binds ({@link OAUTH_CALLBACK_ROUTES}); tests can override
 * them via {@link ProviderManagerOptions} to bind an OS-assigned ephemeral port
 * instead, so parallel runs never collide on a shared socket.
 */
export interface OAuthCallbackRoute {
  readonly path: string;
  readonly port: number;
}

interface ActiveOAuthCallbackPageShim {
  readonly provider: string;
  readonly providerName: string;
  readonly route: OAuthCallbackRoute;
  readonly render: OAuthCallbackPageRenderer | undefined;
  /**
   * Notified exactly once when the browser callback fires and its status
   * (success/error) is known. Lets the flow react immediately instead of
   * waiting on pi-ai (which hangs on non-success callbacks).
   */
  readonly onResult?: ((status: OAuthCallbackPageStatus, context: OAuthCallbackPageContext) => void) | undefined;
}

type ServerResponseEnd = ServerResponse['end'];

export const OAUTH_CALLBACK_ROUTES: Record<string, OAuthCallbackRoute> = {
  anthropic: { path: '/callback', port: 53692 },
  'openai-codex': { path: '/auth/callback', port: 1455 },
};

let activeOAuthCallbackPageShim: ActiveOAuthCallbackPageShim | null = null;
/** Ensures `onResult` fires at most once per installed shim. */
let oauthCallbackResultNotified = false;

/**
 * Probe whether something is already listening on a loopback port. Used to
 * fail an OAuth flow fast (before opening a browser) when the provider's
 * fixed callback port is occupied. Otherwise pi-ai binds the other stack,
 * the browser hits the wrong listener, and the user gets a dead page while
 * pi-ai waits forever.
 */
export function probeCallbackPortInUse(port: number, host: string): Promise<boolean> {
  const net = nodeRequire('node:net') as typeof import('node:net');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    const socket = net.connect({ port, host });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(600, () => finish(false));
  });
}

/**
 * Throw an `OAuthError('callback_port_in_use')` if the provider's fixed
 * callback port is occupied on either IPv4 or IPv6 loopback. No-op for
 * providers without a known callback route (manual/device-code flows).
 */
export async function assertOAuthCallbackPortAvailable(
  provider: string,
  routes: Record<string, OAuthCallbackRoute>,
  probe: (port: number, host: string) => Promise<boolean>,
): Promise<void> {
  const route = routes[provider];
  if (!route) return;

  for (const host of ['127.0.0.1', '::1']) {
    if (await probe(route.port, host)) {
      throw new OAuthError(
        'callback_port_in_use',
        provider,
        `OAuth callback port ${route.port} for "${provider}" is already in use ` +
        `(detected on ${host}). This is a fixed port: another application is ` +
        `holding it, or a previous sign-in did not finish. Close that ` +
        `application (or restart the host process), then try again.`,
        { port: route.port },
      );
    }
  }
}

/**
 * Install the callback-page shim for a flow when there is a known callback
 * route AND something to do with it (a custom renderer and/or a result
 * observer). Returns a release function (a no-op when no shim was installed).
 *
 * Unlike a `try/finally` wrapper around pi-ai's `login()`, the caller owns
 * the release lifecycle: pi-ai's callback-server flows hang forever on a
 * non-success callback, so cleanup must be tied to the flow's own
 * race/timeout, not to awaiting the (possibly never-settling) login promise.
 */
export function maybeInstallOAuthCallbackShim(
  provider: string,
  providerName: string,
  render: OAuthCallbackPageRenderer | undefined,
  onResult: ActiveOAuthCallbackPageShim['onResult'],
  routes: Record<string, OAuthCallbackRoute>,
): () => void {
  const route = routes[provider];
  if (!route || (!render && !onResult)) {
    return () => {};
  }

  return installOAuthCallbackPageShim({
    provider,
    providerName,
    route,
    render,
    onResult,
  });
}

function installOAuthCallbackPageShim(shim: ActiveOAuthCallbackPageShim): () => void {
  if (activeOAuthCallbackPageShim) {
    throw new Error(
      `An OAuth callback page renderer is already active for provider "${activeOAuthCallbackPageShim.provider}".`,
    );
  }

  const http = nodeRequire('node:http') as typeof import('node:http');
  const prototype = http.ServerResponse.prototype;
  const previousEnd = prototype.end;
  activeOAuthCallbackPageShim = shim;
  oauthCallbackResultNotified = false;

  const patchedEnd = function patchedOAuthCallbackEnd(this: ServerResponse, ...args: unknown[]) {
    const replacement = maybeRenderOAuthCallbackPage(this, args[0]);
    if (replacement) {
      args[0] = replacement;
    }

    return Reflect.apply(previousEnd, this, args) as ReturnType<ServerResponseEnd>;
  } as ServerResponseEnd;

  prototype.end = patchedEnd;

  return () => {
    if (activeOAuthCallbackPageShim === shim) {
      activeOAuthCallbackPageShim = null;
    }

    if (prototype.end === patchedEnd) {
      prototype.end = previousEnd;
    }
  };
}

function maybeRenderOAuthCallbackPage(response: ServerResponse, chunk: unknown): string | null {
  const shim = activeOAuthCallbackPageShim;
  if (!shim) return null;

  const request = (response as ServerResponse & { req?: IncomingMessage | undefined }).req;
  if (!request || request.method !== 'GET' || !request.url) return null;

  const localPort = response.socket?.localPort;
  if (localPort !== shim.route.port) return null;

  let url: URL;
  try {
    url = new URL(request.url, `http://localhost:${shim.route.port}`);
  } catch {
    return null;
  }

  if (url.pathname !== shim.route.path) return null;
  if (!isExpectedLocalCallbackHost(request.headers.host, shim.route.port)) return null;

  const contentType = response.getHeader('content-type');
  if (typeof contentType === 'string' && !contentType.toLowerCase().includes('text/html')) {
    return null;
  }

  const defaultHtml = responseChunkToString(chunk);
  if (!defaultHtml || !looksLikePiOAuthPage(defaultHtml)) return null;

  const status = extractOAuthCallbackPageStatus(defaultHtml);
  if (!status) return null;

  const details = extractHtmlClassText(defaultHtml, 'details');
  const context: OAuthCallbackPageContext = {
    provider: shim.provider,
    providerName: shim.providerName,
    status,
    title: extractHtmlTagText(defaultHtml, 'title') ?? defaultOAuthCallbackTitle(status),
    heading: extractHtmlTagText(defaultHtml, 'h1') ?? defaultOAuthCallbackTitle(status),
    message: extractHtmlTagText(defaultHtml, 'p') ?? defaultOAuthCallbackMessage(status),
    callbackPath: shim.route.path,
    callbackPort: shim.route.port,
    defaultHtml,
  };
  if (details !== undefined) {
    context.details = details;
  }

  // Notify the flow that the browser callback fired (once). This lets
  // initiateOAuth react to a failed callback immediately rather than
  // waiting on pi-ai, which hangs on non-success callbacks.
  if (!oauthCallbackResultNotified && shim.onResult) {
    oauthCallbackResultNotified = true;
    try {
      shim.onResult(status, context);
    } catch {
      // An observer must never break the callback response.
    }
  }

  if (!shim.render) return null;
  try {
    const rendered = shim.render(context);
    return typeof rendered === 'string' && rendered.trim().length > 0 ? rendered : null;
  } catch {
    return null;
  }
}

function isExpectedLocalCallbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;

  try {
    const url = new URL(`http://${host}`);
    const hostname = url.hostname.toLowerCase();
    const parsedPort = url.port ? Number(url.port) : 80;
    return (
      parsedPort === port
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function responseChunkToString(chunk: unknown): string | null {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  return null;
}

function looksLikePiOAuthPage(html: string): boolean {
  return (
    html.includes('<title>Authentication successful</title>')
    || html.includes('<title>Authentication failed</title>')
  );
}

function extractOAuthCallbackPageStatus(html: string): OAuthCallbackPageStatus | null {
  if (html.includes('<title>Authentication successful</title>')) return 'success';
  if (html.includes('<title>Authentication failed</title>')) return 'error';
  return null;
}

function defaultOAuthCallbackTitle(status: OAuthCallbackPageStatus): string {
  return status === 'success' ? 'Authentication successful' : 'Authentication failed';
}

function defaultOAuthCallbackMessage(status: OAuthCallbackPageStatus): string {
  return status === 'success' ? 'Authentication completed.' : 'Authentication failed.';
}

function extractHtmlTagText(html: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlText(match[1]) : undefined;
}

function extractHtmlClassText(html: string, className: string): string | undefined {
  const pattern = new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlText(match[1]) : undefined;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim();
}
