import { describe, it, expect } from 'vitest';
import type { OAuthCallbackPageContext } from '@animus-labs/cortex';
import { renderOAuthCallbackPage } from '../../src/providers/oauth-callback-page.js';

function makeContext(overrides: Partial<OAuthCallbackPageContext> = {}): OAuthCallbackPageContext {
  return {
    provider: 'anthropic',
    providerName: 'Anthropic',
    status: 'success',
    title: 'Authentication successful',
    heading: 'Authentication successful',
    message: 'Anthropic authentication completed. You can close this window.',
    callbackPath: '/callback',
    callbackPort: 53692,
    defaultHtml: '<html><title>Authentication successful</title></html>',
    ...overrides,
  };
}

describe('renderOAuthCallbackPage', () => {
  it('renders a self-contained branded success page', () => {
    const html = renderOAuthCallbackPage(makeContext());

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('CORTEX');
    expect(html).toContain('Anthropic');
    expect(html).toContain('signed in');
    // Brand teal wordmark and success accent are inlined.
    expect(html).toContain('#00E5CC');
    expect(html).toContain('#4ADE80');
    // Fully self-contained: no external asset references.
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
  });

  it('renders an error page with the error accent and details', () => {
    const html = renderOAuthCallbackPage(
      makeContext({
        status: 'error',
        heading: 'Authentication failed',
        message: 'Something went wrong.',
        details: 'state mismatch',
      }),
    );

    expect(html).toContain('Sign-in failed');
    expect(html).toContain('#FF6B6B');
    expect(html).toContain('state mismatch');
  });

  it('omits the details block on success', () => {
    const html = renderOAuthCallbackPage(makeContext({ details: 'should not appear' }));
    expect(html).not.toContain('should not appear');
    expect(html).not.toContain('class="details"');
  });

  it('escapes HTML in dynamic values to prevent injection', () => {
    const html = renderOAuthCallbackPage(
      makeContext({
        status: 'error',
        providerName: '<img src=x onerror=alert(1)>',
        details: '<script>alert(2)</script>',
      }),
    );

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('falls back to a generic provider label when none is provided', () => {
    const html = renderOAuthCallbackPage(makeContext({ provider: '', providerName: '' }));
    expect(html).toContain('your provider');
  });
});
