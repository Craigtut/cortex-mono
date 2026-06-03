/**
 * Branded HTML for the browser page shown after an OAuth callback completes.
 *
 * Cortex (`ProviderManager.initiateOAuth`) accepts a `renderCallbackPage`
 * renderer and swaps the returned HTML into pi-ai's localhost callback
 * response. The renderer must be synchronous and self-contained: the page is
 * served exactly once with no asset server, so all CSS/SVG is inlined. If this
 * function throws or returns an empty string, Cortex falls back to pi-ai's
 * default page, so it is intentionally simple and dependency-free.
 *
 * Every dynamic value is HTML-escaped before interpolation. The OAuth `code`
 * and `state` parameters are never exposed to this renderer by Cortex.
 */

import type { OAuthCallbackPageContext } from '@animus-labs/cortex';
import { colors as brand, fonts } from '@animus-labs/brand';

// The brand palette, straight from @animus-labs/brand. This page is a brand
// surface (a browser page, not the terminal), so it uses the full palette:
// acid as the spark, carbon and moss for depth, bone for type.
const BRAND = {
  primary: brand.acid,
  accent: brand.amber,
  success: brand.acid,
  error: brand.cinnabar,
  bg: brand.carbon,
  bgRaised: brand.moss,
  text: brand.bone,
  muted: 'rgba(242, 235, 214, 0.55)', // bone, dimmed
  border: 'rgba(242, 235, 214, 0.10)',
  mono: fonts.mono,
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders the full branded callback page for a Cortex OAuth flow. */
export function renderOAuthCallbackPage(context: OAuthCallbackPageContext): string {
  const isSuccess = context.status === 'success';
  const providerName = escapeHtml(
    context.providerName?.trim() || context.provider?.trim() || 'your provider',
  );

  const accent = isSuccess ? BRAND.success : BRAND.error;
  const docTitle = isSuccess ? 'Cortex Code · Signed in' : 'Cortex Code · Sign-in failed';
  const heading = isSuccess ? 'You’re signed in' : 'Sign-in failed';
  const message = isSuccess
    ? `Your <span class="provider">${providerName}</span> account is connected to Cortex Code.`
    : `Cortex Code couldn’t complete sign-in with <span class="provider">${providerName}</span>.`;

  const icon = isSuccess
    ? `<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="ring" cx="26" cy="26" r="24"/><path class="mark" d="M16 27 l7 7 l14 -15"/></svg>`
    : `<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="ring" cx="26" cy="26" r="24"/><path class="mark" d="M19 19 l14 14 M33 19 l-14 14"/></svg>`;

  // Surface error specifics when pi-ai provided them; never on the happy path.
  const detailText = !isSuccess && context.details?.trim() ? context.details.trim() : '';
  const detailBlock = detailText
    ? `<pre class="details">${escapeHtml(detailText)}</pre>`
    : '';

  const hint = isSuccess
    ? 'You can close this tab and return to your terminal.'
    : 'Close this tab and try again from your terminal.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(docTitle)}</title>
<style>
  :root {
    --primary: ${BRAND.primary};
    --accent: ${accent};
    --bg: ${BRAND.bg};
    --bg-raised: ${BRAND.bgRaised};
    --text: ${BRAND.text};
    --muted: ${BRAND.muted};
    --border: ${BRAND.border};
    --mono: ${BRAND.mono};
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
    background-image:
      radial-gradient(60rem 60rem at 50% -20%, rgba(184, 226, 62, 0.10), transparent 60%),
      radial-gradient(40rem 40rem at 100% 120%, rgba(229, 172, 81, 0.06), transparent 60%);
  }
  .card {
    width: 100%;
    max-width: 420px;
    background: linear-gradient(180deg, var(--bg-raised), rgba(19, 32, 15, 0.6));
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 40px 36px 32px;
    text-align: center;
    box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.7);
    animation: rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .wordmark {
    font-family: var(--mono);
    font-size: 20px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--text);
    margin-bottom: 28px;
  }
  .wordmark .bracket { color: var(--primary); }
  .wordmark .cursor { color: var(--primary); animation: blink 1.1s step-end infinite; }
  .icon {
    width: 72px;
    height: 72px;
    margin: 0 auto 22px;
  }
  .icon svg { width: 100%; height: 100%; display: block; }
  .icon .ring {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    opacity: 0.35;
    stroke-dasharray: 151;
    stroke-dashoffset: 151;
    animation: draw 0.6s ease-out 0.1s forwards;
  }
  .icon .mark {
    fill: none;
    stroke: var(--accent);
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 48;
    stroke-dashoffset: 48;
    animation: draw 0.45s ease-out 0.4s forwards;
  }
  h1 {
    font-size: 22px;
    font-weight: 650;
    margin: 0 0 10px;
    letter-spacing: -0.01em;
  }
  .message {
    font-size: 15px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0 auto;
    max-width: 320px;
  }
  .message .provider { color: var(--text); font-weight: 600; }
  .details {
    text-align: left;
    margin: 22px 0 0;
    padding: 12px 14px;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--error, #FF6B6B);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
  .hint {
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    font-size: 13px;
    color: var(--muted);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes blink { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .card, .icon .ring, .icon .mark, .wordmark .cursor { animation: none; }
    .icon .ring, .icon .mark { stroke-dashoffset: 0; }
  }
</style>
</head>
<body>
  <main class="card" role="status" aria-live="polite">
    <div class="wordmark"><span class="bracket">&lsaquo;</span>cortex<span class="bracket">&rsaquo;</span><span class="cursor">_</span></div>
    <div class="icon" style="--accent: ${accent}">${icon}</div>
    <h1>${escapeHtml(heading)}</h1>
    <p class="message">${message}</p>
    ${detailBlock}
    <p class="hint">${escapeHtml(hint)}</p>
  </main>
</body>
</html>`;
}
