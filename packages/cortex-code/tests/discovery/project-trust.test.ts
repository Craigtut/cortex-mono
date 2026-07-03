import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Redirect the trust store into a throwaway home dir so tests never touch the
// real ~/.cortex/trusted-content.json. The module resolves the path lazily via
// homedir(), so mocking it here is sufficient.
let fakeHome: string;
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  checkProjectTrust,
  recordProjectTrust,
  hashTrustContent,
} from '../../src/discovery/project-trust.js';

const CWD = '/repo/project';

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'project-trust-test-'));
});

afterEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('project-trust', () => {
  it('treats null content as trusted (nothing to gate, no prompt)', async () => {
    expect(await checkProjectTrust(CWD, 'hooks', null)).toBe(true);
    expect(await checkProjectTrust(CWD, 'skills', null)).toBe(true);
    expect(await checkProjectTrust(CWD, 'mcp', null)).toBe(true);
  });

  it('reports new content as untrusted until it is recorded', async () => {
    const content = '{"hooks":{"pre_turn":[{"command":"echo"}]}}';
    expect(await checkProjectTrust(CWD, 'hooks', content)).toBe(false);
    await recordProjectTrust(CWD, 'hooks', content);
    expect(await checkProjectTrust(CWD, 'hooks', content)).toBe(true);
  });

  it('re-flags content that changed after being trusted', async () => {
    const original = 'v1';
    await recordProjectTrust(CWD, 'skills', original);
    expect(await checkProjectTrust(CWD, 'skills', original)).toBe(true);
    // An edit changes the signature: trust must not carry over.
    expect(await checkProjectTrust(CWD, 'skills', 'v2-edited')).toBe(false);
  });

  it('keeps trust independent per kind for the same project', async () => {
    await recordProjectTrust(CWD, 'mcp', 'mcp-config');
    expect(await checkProjectTrust(CWD, 'mcp', 'mcp-config')).toBe(true);
    // Trusting MCP must not implicitly trust hooks or skills.
    expect(await checkProjectTrust(CWD, 'hooks', 'hooks-config')).toBe(false);
    expect(await checkProjectTrust(CWD, 'skills', 'skills-sig')).toBe(false);
  });

  it('keeps trust independent per project for the same kind', async () => {
    await recordProjectTrust('/repo/a', 'hooks', 'same-bytes');
    expect(await checkProjectTrust('/repo/a', 'hooks', 'same-bytes')).toBe(true);
    // A different project with identical bytes is still untrusted.
    expect(await checkProjectTrust('/repo/b', 'hooks', 'same-bytes')).toBe(false);
  });

  it('records the exact displayed content, not whatever is on disk later (TOCTOU)', async () => {
    // Content shown to the user and approved.
    const shown = 'trusted-at-prompt-time';
    await recordProjectTrust(CWD, 'mcp', shown);
    // A subsequent swap to different bytes is NOT trusted: only the approved
    // signature matches. This is the property the threaded-content API buys us.
    expect(await checkProjectTrust(CWD, 'mcp', 'swapped-after-approval')).toBe(false);
    expect(await checkProjectTrust(CWD, 'mcp', shown)).toBe(true);
  });

  it('writes the trust store 0600', async () => {
    await recordProjectTrust(CWD, 'hooks', 'x');
    const storePath = path.join(fakeHome, '.cortex', 'trusted-content.json');
    const mode = fs.statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('hashTrustContent is stable and content-sensitive', () => {
    expect(hashTrustContent('a')).toBe(hashTrustContent('a'));
    expect(hashTrustContent('a')).not.toBe(hashTrustContent('b'));
  });
});
