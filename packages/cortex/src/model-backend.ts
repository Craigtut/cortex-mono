/**
 * Model backends: which server a model's requests go to, and whether that
 * server answers a request while another is in flight (decisions.md D21).
 *
 * The concurrency rule is structural rather than a hand-picked list: every
 * provider pi-ai's catalog knows is a hosted API, and hosted APIs serve
 * concurrent requests, even two for the same model. Two things override
 * that. A local runtime id (a native Ollama model, a custom endpoint) is
 * never judged hosted. And a base URL that points at this machine or a
 * private network is `unknown` whatever the provider id says, because a
 * catalog id aimed at a local proxy is still a local server.
 */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ModelConcurrency } from './model-wrapper.js';

/**
 * Provider ids Cortex stamps on models served by a runtime the consumer
 * runs themselves. None is in pi-ai's catalog today; listing them keeps
 * the rule honest if one ever is.
 */
export const LOCAL_RUNTIME_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'custom']);

/** Where a model's requests go: two models on one backend share its capacity. */
export interface ModelBackend {
  provider: string;
  /** The normalized base URL, or '' when the model declares none. */
  endpoint: string;
}

/** The backend a provider id and base URL name. */
export function modelBackend(provider: string, baseUrl: unknown): ModelBackend {
  return { provider, endpoint: normalizeEndpoint(baseUrl) };
}

/**
 * Whether two models' requests reach one server. Judged by the endpoint's
 * origin, not the provider id: a custom OpenAI-compatible model on Ollama's
 * `/v1` is the same server as a native Ollama model on that port, and
 * `localhost` and `127.0.0.1` are one host. The provider id decides only
 * when a model declares no base URL.
 */
export function sameBackend(a: ModelBackend, b: ModelBackend): boolean {
  return serverKey(a) === serverKey(b);
}

/**
 * Whether a talker and a reasoner on these backends can have requests in
 * flight at once, which is duplex's premise: always on two backends, and
 * on one only when it serves concurrent requests for both models.
 */
export function servedConcurrently(
  a: ModelBackend & { concurrency: ModelConcurrency },
  b: ModelBackend & { concurrency: ModelConcurrency },
): boolean {
  if (!sameBackend(a, b)) return true;
  return a.concurrency === 'parallel' && b.concurrency === 'parallel';
}

function serverKey(backend: ModelBackend): string {
  if (backend.endpoint === '') return `provider:${backend.provider}`;
  try {
    const url = new URL(backend.endpoint);
    const host = isLoopbackHost(url.hostname) ? 'localhost' : url.hostname;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${host}:${port}`;
  } catch {
    return backend.endpoint;
  }
}

/**
 * Concurrency judged from the backend alone. A creator that knows its
 * server better (the native Ollama model) declares its own value, which
 * wins over this one (wrapModel).
 */
export function backendConcurrency(backend: ModelBackend): ModelConcurrency {
  if (isLocalEndpoint(backend.endpoint)) return 'unknown';
  if (LOCAL_RUNTIME_PROVIDER_IDS.has(backend.provider)) return 'unknown';
  return catalogProviderIds().has(backend.provider) ? 'parallel' : 'unknown';
}

let catalogIds: ReadonlySet<string> | null = null;

/** Every provider id pi-ai ships, including gateways with no static model list. */
function catalogProviderIds(): ReadonlySet<string> {
  catalogIds ??= new Set(builtinProviders().map((provider) => provider.id));
  return catalogIds;
}

/**
 * Lower-cased origin plus path without a trailing slash, so two spellings
 * of one server compare equal. A value that is not a URL (a templated
 * catalog URL like `https://{location}-...`) is kept as written.
 */
function normalizeEndpoint(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return '';
  try {
    const url = new URL(baseUrl.trim());
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return baseUrl.trim();
  }
}

const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa'];

/**
 * Whether an endpoint is on this machine or a private network: loopback,
 * RFC 1918 and link-local addresses, IPv6 unique-local and link-local,
 * the shared address space tailnets use, mDNS and other private-use names,
 * and single-label hosts, which public DNS never resolves.
 */
export function isLocalEndpoint(endpoint: string): boolean {
  if (endpoint === '') return false;
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) return isLocalIPv6(host.slice(1, -1));
  if (isLoopbackHost(host)) return true;
  const v4 = parseIPv4(host);
  if (v4) return isLocalIPv4(v4);
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return host !== '' && !host.includes('.');
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  return parseIPv4(host)?.[0] === 127;
}

function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isLocalIPv4([a, b]: number[]): boolean {
  return a === 127 || a === 10 || a === 0
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b! >= 64 && b! <= 127);
}

function isLocalIPv6(host: string): boolean {
  if (host === '::1' || host === '::') return true;
  // IPv4-mapped (::ffff:7f00:1 once the URL parser has normalized it).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    return isLocalIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}
