import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../src/config/config.js';

// Sandbox posture must come from trusted (global) config only. A project file in
// the workspace working tree (which may be an untrusted cloned repo) must never
// be able to disable or weaken the sandbox before the user acts.
describe('loadConfig sandbox trust', () => {
  let cwd = '';

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cfgtrust-'));
    fs.mkdirSync(path.join(cwd, '.cortex'), { recursive: true });
  });

  afterEach(() => {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('drops a project-level sandbox block while keeping other project keys', async () => {
    fs.writeFileSync(
      path.join(cwd, '.cortex', 'config.json'),
      JSON.stringify({
        defaultModel: 'project-model',
        sandbox: { enabled: false, rung: 'off', allowedDomains: ['project-marker.example'] },
      }),
    );

    const config = await loadConfig(cwd);

    // Non-sandbox project keys still apply.
    expect(config.defaultModel).toBe('project-model');
    // The project sandbox block must not take effect: the repo cannot disable or
    // weaken the sandbox. Global config (if any) is the only source, and never
    // carries this project marker.
    expect(config.sandbox?.allowedDomains ?? []).not.toContain('project-marker.example');
    expect(config.sandbox?.enabled).not.toBe(false);
  });
});
