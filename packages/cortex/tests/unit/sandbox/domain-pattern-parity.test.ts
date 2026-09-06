import { describe, it, expect } from 'vitest';
import { matchesDomainPattern } from '../../../src/sandbox/policy.js';
// Deep import of sandbox-runtime's internal matcher (not re-exported from its
// package index). If a version bump moves or renames this module, the import
// fails and this test fails loudly, which is exactly the signal we want: the
// unified-network property (WebFetch and shell egress agreeing on what an
// allowlist entry means) rests on our mirror staying in step with the OS
// proxy's matcher, so a desync must never pass silently.
import { matchesDomainPattern as upstreamMatch } from '@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js';

describe('matchesDomainPattern parity with sandbox-runtime', () => {
  const patterns = [
    '*',
    '*.example.com',
    'example.com',
    'api.example.com',
    'EXAMPLE.com',
    '*.co',
    '*.github.com',
    'github.com',
    'localhost',
    '127.0.0.1',
    '::1',
  ];
  const hosts = [
    'example.com',
    'EXAMPLE.COM',
    'api.example.com',
    'a.b.example.com',
    'example.com.',
    'notexample.com',
    'example.com.evil.com',
    'a.example.com.evil.com',
    'evil.com',
    'github.com',
    'api.github.com',
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    '2130706433',
    'xn--exmple-4nf.com',
    'sub.example.co',
    'example.co',
    '',
  ];

  it('agrees with the upstream matcher on every host x pattern', () => {
    const divergences: string[] = [];
    for (const host of hosts) {
      for (const pattern of patterns) {
        const ours = matchesDomainPattern(host, pattern);
        const theirs = upstreamMatch(host, pattern);
        if (ours !== theirs) {
          divergences.push(
            `host=${JSON.stringify(host)} pattern=${JSON.stringify(pattern)}: ours=${ours} upstream=${theirs}`,
          );
        }
      }
    }
    expect(divergences).toEqual([]);
  });
});
