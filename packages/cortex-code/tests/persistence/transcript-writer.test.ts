import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TranscriptWriter,
  extractToolResultText,
  type TranscriptRecord,
} from '../../src/persistence/transcript-writer.js';

const tempRoots: string[] = [];

async function tempSessionsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-transcript-'));
  tempRoots.push(dir);
  return dir;
}

async function readTranscript(sessionsDir: string, sessionId: string): Promise<TranscriptRecord[]> {
  const raw = await readFile(join(sessionsDir, sessionId, 'transcript.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptRecord);
}

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('TranscriptWriter', () => {
  it('writes session_meta as the first record with id, cwd, cliVersion, provider, model, and git', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-1', '/work/dir', {
      sessionsDir,
      cliVersion: '9.9.9',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    });
    await writer.initialize({ gitBranch: 'main' });
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      sequence: 1,
      sessionId: 'sess-1',
      type: 'session_meta',
      payload: {
        id: 'sess-1',
        cwd: '/work/dir',
        cliVersion: '9.9.9',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        git: { branch: 'main' },
      },
    });
    expect(typeof records[0]!.timestamp).toBe('string');
  });

  it('appends records with a monotonic sequence and the contract record shapes', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-2', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await writer.initialize();
    writer.addUserMessage('hello there');
    writer.addToolCall('tool-1', 'Bash', { command: 'ls -la' });
    writer.addToolResult('tool-1', false, 'total 0');
    writer.addAssistantMessage('done looking');
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-2');
    expect(records.map((r) => r.type)).toEqual([
      'session_meta',
      'user_message',
      'tool_call',
      'tool_result',
      'assistant_message',
    ]);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]);

    expect(records[1]!.payload).toEqual({ text: 'hello there' });
    expect(records[2]!.payload).toEqual({
      toolCallId: 'tool-1',
      name: 'Bash',
      args: JSON.stringify({ command: 'ls -la' }),
    });
    expect(records[3]!.payload).toEqual({ toolCallId: 'tool-1', isError: false, output: 'total 0' });
    expect(records[4]!.payload).toEqual({ text: 'done looking' });
  });

  it('records error, compaction, and sub_agent lifecycle events', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-evt', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await writer.initialize();
    writer.addError('Could not reach the API.', 'network');
    writer.addCompaction({ beforeTokens: 120_000, afterTokens: 40_000 });
    writer.addSubAgent('task-1', 'spawned', { summary: 'find the bug', background: false });
    writer.addSubAgent('task-1', 'completed', { summary: 'found it in foo.ts' });
    writer.addSubAgent('task-2', 'failed', { error: 'timed out' });
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-evt');
    expect(records.map((r) => r.type)).toEqual([
      'session_meta',
      'error',
      'compaction',
      'sub_agent',
      'sub_agent',
      'sub_agent',
    ]);
    expect(records[1]!.payload).toEqual({ kind: 'network', message: 'Could not reach the API.' });
    expect(records[2]!.payload).toEqual({ beforeTokens: 120_000, afterTokens: 40_000 });
    expect(records[3]!.payload).toEqual({
      taskId: 'task-1',
      status: 'spawned',
      background: false,
      summary: 'find the bug',
    });
    expect(records[4]!.payload).toEqual({ taskId: 'task-1', status: 'completed', summary: 'found it in foo.ts' });
    expect(records[5]!.payload).toEqual({ taskId: 'task-2', status: 'failed', error: 'timed out' });
  });

  it('is append-only: a second writer continues without re-emitting session_meta', async () => {
    const sessionsDir = await tempSessionsDir();

    const first = new TranscriptWriter('sess-3', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await first.initialize();
    first.addUserMessage('first turn');
    await first.flush();

    const before = await readFile(join(sessionsDir, 'sess-3', 'transcript.jsonl'), 'utf8');

    const resumed = new TranscriptWriter('sess-3', '/work/dir', {
      sessionsDir,
      cliVersion: '1.0.0',
      resume: true,
    });
    await resumed.initialize();
    resumed.addUserMessage('second turn');
    await resumed.flush();

    const records = await readTranscript(sessionsDir, 'sess-3');
    // Exactly one session_meta, and prior lines are untouched (append-only).
    expect(records.filter((r) => r.type === 'session_meta')).toHaveLength(1);
    expect(records.map((r) => r.type)).toEqual(['session_meta', 'user_message', 'user_message']);
    // Sequence continues from where the first writer left off.
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3]);

    const after = await readFile(join(sessionsDir, 'sess-3', 'transcript.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
  });

  it('spills oversized output to a sidecar blob with a recoverable reference, never truncating to data loss', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-4', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await writer.initialize();

    const hugeOutput = 'x'.repeat(100_000);
    const hugeArg = 'y'.repeat(100_000);
    writer.addToolCall('tool-9', 'Grep', { pattern: 'foo', blob: hugeArg });
    writer.addToolResult('tool-9', false, hugeOutput);
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-4');
    const call = records.find((r) => r.type === 'tool_call')!;
    const result = records.find((r) => r.type === 'tool_result')!;

    // Inline value is a bounded preview; the reference + byte count let a reader
    // recover the full content from the sidecar.
    const outputPreview = result.payload['output'] as string;
    const outputRef = result.payload['output_ref'] as string;
    expect(outputPreview.length).toBeLessThan(hugeOutput.length);
    expect(outputRef).toMatch(/^transcript-blobs\/blob-[0-9a-f]+\.txt$/);
    expect(result.payload['output_bytes']).toBe(100_000);

    const argsRef = call.payload['args_ref'] as string;
    expect(argsRef).toMatch(/^transcript-blobs\/blob-[0-9a-f]+\.txt$/);

    // Full output is recoverable from the spilled blob (no data loss).
    const spilled = await readFile(join(sessionsDir, 'sess-4', outputRef), 'utf8');
    expect(spilled).toBe(hugeOutput);
  });

  it('keeps an already-bookended (under-cap) tool result inline, mirroring memory', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-bk', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await writer.initialize();

    // What Cortex holds in memory for a spilled result: a short bookend preview
    // plus the persisted-file reference. Well under the inline cap.
    const inMemory = '[Result persisted: /home/u/.cortex/sessions/x/tool-results/Grep-abc.md (900,000 chars)]\n\nhead…\n\ntail…';
    writer.addToolResult('tool-bk', false, inMemory);
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-bk');
    const result = records.find((r) => r.type === 'tool_result')!;
    // Stored verbatim, no second truncation, no sidecar spill.
    expect(result.payload['output']).toBe(inMemory);
    expect(result.payload['output_ref']).toBeUndefined();
  });

  it('records tool errors with the error text as output and isError true', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-5', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await writer.initialize();
    writer.addToolResult('tool-x', true, 'command not found');
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-5');
    const result = records.find((r) => r.type === 'tool_result')!;
    expect(result.payload).toEqual({ toolCallId: 'tool-x', isError: true, output: 'command not found' });
  });

  it('skips empty assistant messages', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-6', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await writer.initialize();
    writer.addAssistantMessage('   ');
    writer.addAssistantMessage('real text');
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-6');
    const assistant = records.filter((r) => r.type === 'assistant_message');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.payload).toEqual({ text: 'real text' });
  });

  it('applies initialize() extras even when a write scheduled the header first', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-extras', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    // A write lazily schedules the header before initialize() is called. The
    // git branch must still land in session_meta because settleHeader has not
    // run yet when initialize() captures the extras.
    writer.addUserMessage('first');
    await writer.initialize({ gitBranch: 'feature/x' });
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-extras');
    expect(records[0]!.type).toBe('session_meta');
    expect(records[0]!.payload['git']).toEqual({ branch: 'feature/x' });
    expect(records.map((r) => r.type)).toEqual(['session_meta', 'user_message']);
  });

  it('continues a pre-existing transcript on a non-resume session rather than clobbering it', async () => {
    const sessionsDir = await tempSessionsDir();

    const first = new TranscriptWriter('sess-noclobber', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await first.initialize();
    first.addUserMessage('original turn');
    await first.flush();
    const before = await readFile(join(sessionsDir, 'sess-noclobber', 'transcript.jsonl'), 'utf8');

    // A fresh (non-resume) writer that finds an existing file must continue it.
    const second = new TranscriptWriter('sess-noclobber', '/work/dir', {
      sessionsDir,
      cliVersion: '1.0.0',
      resume: false,
    });
    await second.initialize();
    second.addUserMessage('next turn');
    await second.flush();

    const records = await readTranscript(sessionsDir, 'sess-noclobber');
    expect(records.filter((r) => r.type === 'session_meta')).toHaveLength(1);
    expect(records.map((r) => r.type)).toEqual(['session_meta', 'user_message', 'user_message']);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3]);
    const after = await readFile(join(sessionsDir, 'sess-noclobber', 'transcript.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
  });

  it('swallows write failures: flush resolves, onWriteError fires, nothing throws', async () => {
    const sessionsDir = await tempSessionsDir();
    // Put a regular file where the session directory should be, so every mkdir
    // of the session dir fails and all writes error out.
    await writeFile(join(sessionsDir, 'sess-fail'), 'blocker');

    const errors: unknown[] = [];
    const writer = new TranscriptWriter('sess-fail', '/work/dir', {
      sessionsDir,
      cliVersion: '1.0.0',
      onWriteError: (error) => errors.push(error),
    });
    await writer.initialize();
    writer.addUserMessage('this cannot be written');

    await expect(writer.flush()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('writes session_meta first even when initialize() is never called', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-hdr', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    // No initialize(): the first write must still schedule the header ahead of itself.
    writer.addUserMessage('straight to a message');
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-hdr');
    expect(records.map((r) => r.type)).toEqual(['session_meta', 'user_message']);
    expect(records.map((r) => r.sequence)).toEqual([1, 2]);
  });

  it('does not rotate: many records stay in a single transcript.jsonl', async () => {
    const sessionsDir = await tempSessionsDir();
    const writer = new TranscriptWriter('sess-rot', '/work/dir', { sessionsDir, cliVersion: '1.0.0' });
    await writer.initialize();
    for (let i = 0; i < 200; i++) {
      writer.addUserMessage(`message ${i}`);
    }
    await writer.flush();

    const files = (await readdir(join(sessionsDir, 'sess-rot'))).sort();
    expect(files).toEqual(['transcript.jsonl']);
    const records = await readTranscript(sessionsDir, 'sess-rot');
    expect(records).toHaveLength(201); // session_meta + 200 messages
  });

  it('uses a monotonic clock injection for deterministic timestamps', async () => {
    const sessionsDir = await tempSessionsDir();
    let tick = 0;
    const writer = new TranscriptWriter('sess-7', '/work/dir', {
      sessionsDir,
      cliVersion: '1.0.0',
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    await writer.initialize();
    writer.addUserMessage('hi');
    await writer.flush();

    const records = await readTranscript(sessionsDir, 'sess-7');
    expect(records[0]!.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(records[1]!.timestamp).toBe('2026-01-01T00:00:01.000Z');
  });
});

describe('extractToolResultText', () => {
  it('flattens ToolContentDetails content arrays to joined text', () => {
    const result = {
      content: [
        { type: 'text', text: 'line one' },
        { type: 'image', data: 'base64', mimeType: 'image/png' },
        { type: 'text', text: 'line two' },
      ],
      details: { exitCode: 0 },
    };
    expect(extractToolResultText(result)).toBe('line one\nline two');
  });

  it('passes strings through and stringifies unknown shapes', () => {
    expect(extractToolResultText('plain')).toBe('plain');
    expect(extractToolResultText(null)).toBe('');
    expect(extractToolResultText(undefined)).toBe('');
    expect(extractToolResultText({ unexpected: true })).toBe('{"unexpected":true}');
  });
});
