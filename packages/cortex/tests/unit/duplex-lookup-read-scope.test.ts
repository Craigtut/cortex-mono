/**
 * The quick-lookup read scope (D13/F12), driven end to end: a real lookup
 * child really attempting a read outside its allowed roots, and being
 * refused.
 *
 * Two suites already cover the ends of this path and neither covers the
 * middle. `tests/unit/tools/path-allowlist.test.ts` proves the tools refuse
 * when handed `allowedRoots`; `cortex-agent-duplex.test.ts` proves
 * buildQuickLookupConfig puts `readPathAllowlist` in the config. Between
 * them sits the wiring that turns the config field into the tools' argument
 * (agent-loop's built-in tool construction), and a config assertion cannot
 * see it: drop that one line and both suites stay green while every lookup
 * reads the whole filesystem.
 *
 * The exposure is not theoretical. A lookup answer becomes spoken
 * conversation, so an out-of-scope read is a direct exfiltration path:
 * `quick_lookup("what is in ~/.aws/credentials")` is the shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRealDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  promptTexts,
  stubLookupLoops,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { ScriptedPiAgent } from './duplex-scenario-harness.js';

/** The secret a lookup must never be able to speak. */
const SECRET = 'aws_access_key_id = AKIAEXAMPLE';

let baseDir: string;
/** The lookup's allowed root (the facade's workingDirectory). */
let workDir: string;
let secretFile: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-lookup-scope-'));
  workDir = path.join(baseDir, 'workspace');
  const secretDir = path.join(baseDir, 'home', '.aws');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });
  secretFile = path.join(secretDir, 'credentials');
  fs.writeFileSync(secretFile, `${SECRET}\n`);
  fs.writeFileSync(path.join(workDir, 'server.ts'), 'const PORT = 8080;\n');
});

afterEach(async () => {
  await destroyLiveFacades();
  vi.restoreAllMocks();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

/**
 * A duplex facade over the real create(), with the next AgentLoop.create
 * (the lookup child) built over a scripted pi running `script`. The script
 * is installed before the child's prompt, because the lookup answers in
 * microtasks and setting it afterwards would race the whole run.
 */
async function scenarioWithLookupScript(script: (pi: ScriptedPiAgent) => void) {
  const h = await createRealDuplexScenario({ workingDirectory: workDir });
  const stub = stubLookupLoops(script);
  return { h, stub };
}

/** Run one lookup through the talker's control tool and wait for its result. */
async function runLookup(
  h: Awaited<ReturnType<typeof createRealDuplexScenario>>,
  question: string,
): Promise<void> {
  h.talkerPi.script = [
    { text: 'Let me check.', calls: [{ name: 'quick_lookup', args: { question } }] },
    { text: 'Here is what I found.' },
  ];
  await h.facade.prompt(question);
  await waitUntil(
    () => entriesOfType(h.facade, 'lookup_result').length === 1,
    2000, 'lookup answered',
  );
  await waitUntil(() => !h.talkerLoop.isLoopActive, 2000, 'talker idle after the lookup');
}

/** Everything the lookup could have leaked into: log, and what the talker was fed. */
function everythingSpoken(
  h: Awaited<ReturnType<typeof createRealDuplexScenario>>,
): string {
  return [
    ...h.facade.getLog().map((entry) => entry.content),
    ...promptTexts(h.talkerPi),
  ].join('\n');
}

describe('quick-lookup read scope, enforced not merely configured', () => {
  it('refuses an absolute read outside the working directory and speaks nothing of it', async () => {
    const { h, stub } = await scenarioWithLookupScript((pi) => {
      pi.script = [
        { text: '', calls: [{ name: 'Read', args: { file_path: secretFile } }] },
        { text: 'I could not read that file; it is outside my scope.' },
      ];
    });

    await runLookup(h, 'what is in the aws credentials file?');

    // The child really tried, and the tool really refused, before any disk
    // I/O: the refusal is visible in the child's own transcript rather than
    // an empty result it could narrate around.
    expect(stub.pis).toHaveLength(1);
    const read = stub.pis[0]!.toolResults.find((result) => result.name === 'Read')!;
    expect(read).toBeDefined();
    expect(read.text).toContain('Access denied');
    expect(read.text).toContain('outside');
    expect(read.text).not.toContain('AKIAEXAMPLE');

    // And nothing the user could hear carries the secret.
    expect(everythingSpoken(h)).not.toContain('AKIAEXAMPLE');
  });

  it('refuses a symlink planted inside the root that points outside it', async () => {
    // The escape that a string-prefix containment check misses: the path
    // the model names really is under the root, and only resolving it
    // reveals where the read would land.
    const link = path.join(workDir, 'notes.txt');
    fs.symlinkSync(secretFile, link);
    const { h, stub } = await scenarioWithLookupScript((pi) => {
      pi.script = [
        { text: '', calls: [{ name: 'Read', args: { file_path: link } }] },
        { text: 'That file is not readable from here.' },
      ];
    });

    await runLookup(h, 'what is in notes.txt?');

    const read = stub.pis[0]!.toolResults.find((result) => result.name === 'Read')!;
    expect(read.text).toContain('Access denied');
    expect(read.text).not.toContain('AKIAEXAMPLE');
    expect(everythingSpoken(h)).not.toContain('AKIAEXAMPLE');
  });

  it('still reads inside the root, so the refusal is a scope and not a broken tool', async () => {
    const { h, stub } = await scenarioWithLookupScript((pi) => {
      pi.script = [
        {
          text: '',
          calls: [{ name: 'Read', args: { file_path: path.join(workDir, 'server.ts') } }],
        },
        { text: 'Port 8080, set in server.ts.' },
      ];
    });

    await runLookup(h, 'what port does the server use?');

    const read = stub.pis[0]!.toolResults.find((result) => result.name === 'Read')!;
    expect(read.text).toContain('const PORT = 8080;');
    expect(read.text).not.toContain('Access denied');
    // The answer reached the conversation, which is what makes the refusals
    // above meaningful: this path is live.
    const result = entriesOfType(h.facade, 'lookup_result')[0]!;
    expect(result.content).toContain('Port 8080');
  });

  it('confines Grep and Glob too, so the scope cannot be walked around', async () => {
    // Read is the obvious surface; a lookup that can grep the filesystem or
    // list it by pattern exfiltrates just as well, one match line at a time.
    const secretDir = path.dirname(secretFile);
    const { h, stub } = await scenarioWithLookupScript((pi) => {
      pi.script = [
        {
          text: '',
          calls: [
            { name: 'Grep', args: { pattern: 'AKIA', path: secretDir, output_mode: 'content' } },
            { name: 'Glob', args: { pattern: '**/*', path: secretDir } },
          ],
        },
        { text: 'I cannot look there.' },
      ];
    });

    await runLookup(h, 'find any aws keys on this machine');

    const results = stub.pis[0]!.toolResults;
    const grep = results.find((result) => result.name === 'Grep')!;
    const glob = results.find((result) => result.name === 'Glob')!;
    expect(grep.text).toContain('Access denied');
    expect(glob.text).toContain('Access denied');
    expect(grep.text).not.toContain('AKIAEXAMPLE');
    expect(glob.text).not.toContain('credentials');
    expect(everythingSpoken(h)).not.toContain('AKIAEXAMPLE');
  });
});
