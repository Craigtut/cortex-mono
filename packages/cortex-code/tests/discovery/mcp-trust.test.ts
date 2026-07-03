/**
 * MCP trust adapter over the shared project-trust store, including the TOCTOU
 * fix: the content displayed at the prompt is what gets recorded, not a fresh
 * read at approval time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let fakeHome: string;
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

import { checkProjectMcpTrust, trustProjectMcpConfig } from '../../src/discovery/mcp-trust.js';

let cwd: string;
const MCP_JSON = JSON.stringify({ mcpServers: { weather: { command: 'node', args: ['w.js'] } } });

function writeMcp(content: string): void {
  fs.mkdirSync(path.join(cwd, '.cortex'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.cortex', 'mcp.json'), content);
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trust-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trust-proj-'));
});

afterEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('mcp-trust', () => {
  it('trusts a project with no mcp.json (nothing to gate)', async () => {
    const result = await checkProjectMcpTrust(cwd);
    expect(result).toEqual({ trusted: true, configContent: null });
  });

  it('flags a new config as untrusted and returns its content', async () => {
    writeMcp(MCP_JSON);
    const result = await checkProjectMcpTrust(cwd);
    expect(result.trusted).toBe(false);
    expect(result.configContent).toBe(MCP_JSON);
  });

  it('trusts the exact displayed content and rejects a later swap (TOCTOU)', async () => {
    writeMcp(MCP_JSON);
    const shown = (await checkProjectMcpTrust(cwd)).configContent!;

    // Approve the content we displayed.
    await trustProjectMcpConfig(cwd, shown);
    expect((await checkProjectMcpTrust(cwd)).trusted).toBe(true);

    // Swap the file after approval: the stored hash is of `shown`, so the new
    // bytes are untrusted.
    const swapped = JSON.stringify({ mcpServers: { evil: { command: 'sh', args: ['-c', 'curl x'] } } });
    writeMcp(swapped);
    const after = await checkProjectMcpTrust(cwd);
    expect(after.trusted).toBe(false);
    expect(after.configContent).toBe(swapped);
  });

  it('does not trust a swapped file even if approval re-reads disk', async () => {
    // Content shown to the user.
    writeMcp(MCP_JSON);
    const shown = (await checkProjectMcpTrust(cwd)).configContent!;
    // Attacker swaps the file before the click lands.
    const swapped = JSON.stringify({ mcpServers: { evil: {} } });
    writeMcp(swapped);
    // Threading the DISPLAYED content records only what was shown; the swapped
    // file remains untrusted.
    await trustProjectMcpConfig(cwd, shown);
    expect((await checkProjectMcpTrust(cwd)).trusted).toBe(false);
  });
});
