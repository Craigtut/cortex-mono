import { describe, it, expect } from 'vitest';
import {
  buildDefaultPolicy,
  matchesDomainPattern,
  matchesAnyDomainPattern,
  SEEDED_REGISTRY_DOMAINS,
  DEFAULT_CREDENTIAL_ENV_VARS,
} from '../src/policy.js';

// Deterministic, platform-independent: guards the rung->policy mapping and the
// default deny/allow lists without needing an OS sandbox.
describe('buildDefaultPolicy', () => {
  // Non-existent paths so realpath canonicalization is a no-op and assertions
  // match the inputs verbatim.
  const opts = {
    workspaceRoots: ['/nope/ws'],
    home: '/nope/home',
    sessionTmpDir: '/nope/tmp',
  };

  it('restricted: read-only, no network', () => {
    const p = buildDefaultPolicy('restricted', opts);
    expect(p.filesystem.writableRoots).toEqual([]);
    expect(p.network.mode).toBe('deny');
    expect(p.network.allowedDomains).toEqual([]);
  });

  it('workspace: writable roots + seeded registry allowlist', () => {
    const p = buildDefaultPolicy('workspace', opts);
    expect(p.filesystem.writableRoots).toContain('/nope/ws');
    expect(p.network.mode).toBe('allowlist');
    expect(p.network.allowedDomains).toContain('registry.npmjs.org');
    expect(p.network.allowedDomains).toContain('github.com');
  });

  it('trusted: writable roots + open (proxy-mediated) network', () => {
    const p = buildDefaultPolicy('trusted', opts);
    expect(p.filesystem.writableRoots).toContain('/nope/ws');
    expect(p.network.mode).toBe('full');
  });

  it('denies reading secret stores and writing persistence targets on every contained rung', () => {
    const p = buildDefaultPolicy('workspace', opts);
    expect(p.filesystem.denyRead.some((x) => x.endsWith('.ssh'))).toBe(true);
    expect(p.filesystem.denyRead.some((x) => x.endsWith('.npmrc'))).toBe(true);
    expect(p.filesystem.denyRead.some((x) => x.endsWith('.git-credentials'))).toBe(true);
    expect(p.filesystem.denyWrite.some((x) => x.endsWith('.zshrc'))).toBe(true);
    expect(p.filesystem.denyWrite.some((x) => x.includes('.git') && x.endsWith('hooks'))).toBe(true);
    expect(p.filesystem.denyWrite.some((x) => x.includes('.git') && x.endsWith('config'))).toBe(true);
  });

  it('applies consumer extras (extra deny-write/deny-read/allow)', () => {
    const p = buildDefaultPolicy('workspace', {
      ...opts,
      extraDenyWrite: ['/nope/home/.cortex/settings.json'],
      extraDenyRead: ['/nope/home/.cortex/credentials.json'],
      extraAllowedDomains: ['registry.example.com'],
    });
    expect(p.filesystem.denyWrite).toContain('/nope/home/.cortex/settings.json');
    expect(p.filesystem.denyRead).toContain('/nope/home/.cortex/credentials.json');
    expect(p.network.allowedDomains).toContain('registry.example.com');
  });

  it('exposes seeded registry and credential env-var lists', () => {
    expect(SEEDED_REGISTRY_DOMAINS.length).toBeGreaterThan(5);
    expect(DEFAULT_CREDENTIAL_ENV_VARS).toContain('GITHUB_TOKEN');
    expect(DEFAULT_CREDENTIAL_ENV_VARS).toContain('AWS_SECRET_ACCESS_KEY');
    expect(DEFAULT_CREDENTIAL_ENV_VARS).toContain('ANTHROPIC_API_KEY');
  });
});

// Mirrors sandbox-runtime's proxy matcher; both egress paths (OS proxy for
// shell, this matcher for WebFetch) must agree on what an allowlist entry means.
describe('matchesDomainPattern', () => {
  it('matches exactly, case-insensitively', () => {
    expect(matchesDomainPattern('GitHub.com', 'github.com')).toBe(true);
    expect(matchesDomainPattern('github.com', 'GitHub.com')).toBe(true);
    expect(matchesDomainPattern('notgithub.com', 'github.com')).toBe(false);
  });

  it('wildcard matches strict subdomains only', () => {
    expect(matchesDomainPattern('api.github.com', '*.github.com')).toBe(true);
    expect(matchesDomainPattern('deep.api.github.com', '*.github.com')).toBe(true);
    expect(matchesDomainPattern('github.com', '*.github.com')).toBe(false);
    expect(matchesDomainPattern('evilgithub.com', '*.github.com')).toBe(false);
  });

  it('bare * matches everything', () => {
    expect(matchesDomainPattern('anything.example', '*')).toBe(true);
  });

  it('wildcards never match IP literals', () => {
    expect(matchesDomainPattern('1.2.3.4', '*.3.4')).toBe(false);
    expect(matchesDomainPattern('[2001:db8::1]', '*.db8::1')).toBe(false);
    // exact IP entries still match
    expect(matchesDomainPattern('1.2.3.4', '1.2.3.4')).toBe(true);
  });

  it('matchesAnyDomainPattern walks a list', () => {
    expect(matchesAnyDomainPattern('registry.npmjs.org', SEEDED_REGISTRY_DOMAINS)).toBe(true);
    expect(matchesAnyDomainPattern('files.pythonhosted.org', SEEDED_REGISTRY_DOMAINS)).toBe(true);
    expect(matchesAnyDomainPattern('evil.example.com', SEEDED_REGISTRY_DOMAINS)).toBe(false);
  });
});
