import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { PersistResultFn, SessionUsage } from '@animus-labs/cortex';

const SESSIONS_DIR = join(homedir(), '.cortex', 'sessions');

export interface SessionMeta {
  id: string;
  mode: string;
  provider: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  contextTokenCount: number;
  /** Accumulated session usage (cost, turns, tokens). Optional for backward compat. */
  usage?: SessionUsage;
  /** Compaction strategy used by this session. Optional for backward compat. */
  compactionStrategy?: 'observational' | 'classic';
}

export interface SavedSession {
  meta: SessionMeta;
  history: unknown[];
}

/**
 * Session history is restored into Cortex for model context, not replayed into
 * the transcript. Tool result `details` payloads are often bulky and can
 * duplicate file contents or diffs, especially for Edit/Write. Strip them
 * before persistence so autosave stays cheap during edit-heavy sessions.
 */
export function sanitizeHistoryForSave(history: unknown[]): unknown[] {
  return history.map((entry) => {
    if (typeof entry !== 'object' || entry === null || !('details' in entry)) {
      return entry;
    }

    const { details: _details, ...rest } = entry as Record<string, unknown>;
    return rest;
  });
}

function parseSessionMeta(v: unknown): SessionMeta | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const contextTokenCount = typeof o['contextTokenCount'] === 'number'
    ? o['contextTokenCount']
    : typeof o['tokenCount'] === 'number'
      ? o['tokenCount']
      : null;
  if (
    typeof o['id'] !== 'string' ||
    typeof o['mode'] !== 'string' ||
    typeof o['provider'] !== 'string' ||
    typeof o['model'] !== 'string' ||
    typeof o['cwd'] !== 'string' ||
    typeof o['createdAt'] !== 'number' ||
    typeof o['updatedAt'] !== 'number' ||
    contextTokenCount === null
  ) {
    return null;
  }

  const usage = o['usage'] as SessionUsage | undefined;
  const compactionStrategy = o['compactionStrategy'] === 'observational' || o['compactionStrategy'] === 'classic'
    ? o['compactionStrategy']
    : undefined;

  return {
    id: o['id'],
    mode: o['mode'],
    provider: o['provider'],
    model: o['model'],
    cwd: o['cwd'],
    createdAt: o['createdAt'],
    updatedAt: o['updatedAt'],
    contextTokenCount,
    ...(usage ? { usage } : {}),
    ...(compactionStrategy ? { compactionStrategy } : {}),
  };
}

export function generateSessionId(): string {
  return randomUUID();
}

export async function saveSession(
  sessionId: string,
  history: unknown[],
  meta: SessionMeta,
): Promise<void> {
  const dir = join(SESSIONS_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  const sanitizedHistory = sanitizeHistoryForSave(history);

  await Promise.all([
    writeFile(join(dir, 'history.json'), JSON.stringify(sanitizedHistory)),
    writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2)),
  ]);
}

export async function loadSession(sessionId: string): Promise<SavedSession | null> {
  const dir = join(SESSIONS_DIR, sessionId);
  try {
    const [historyRaw, metaRaw] = await Promise.all([
      readFile(join(dir, 'history.json'), 'utf-8'),
      readFile(join(dir, 'meta.json'), 'utf-8'),
    ]);
    const history: unknown = JSON.parse(historyRaw);
    const meta: unknown = JSON.parse(metaRaw);

    if (!Array.isArray(history)) return null;
    const parsedMeta = parseSessionMeta(meta);
    if (!parsedMeta) return null;

    return { history, meta: parsedMeta };
  } catch {
    return null;
  }
}

export async function saveObservationalState(
  sessionId: string,
  state: unknown,
): Promise<void> {
  const dir = join(SESSIONS_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'observations.json'), JSON.stringify(state));
}

export async function loadObservationalState(
  sessionId: string,
): Promise<unknown | null> {
  try {
    const raw = await readFile(join(SESSIONS_DIR, sessionId, 'observations.json'), 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Sanitize a tool name for use in a filename. Tool names can include MCP
 * namespacing (e.g. `mcp__playwright__browser_snapshot`), which is already
 * filename-safe, but we still strip anything outside [A-Za-z0-9_-] to be safe.
 */
function safeToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Build a persistor that writes oversized tool results to
 * `~/.cortex/sessions/{sessionId}/tool-results/`. The returned absolute path
 * is embedded in the replacement text Cortex writes into the conversation, so
 * the agent can re-read the full content via the Read tool. Paths live in
 * message `content`, which survives `sanitizeHistoryForSave`, so they remain
 * valid across session reload.
 */
export function createToolResultPersistor(sessionId: string): PersistResultFn {
  const dir = join(SESSIONS_DIR, sessionId, 'tool-results');
  let dirReady: Promise<void> | null = null;

  return async (content, metadata) => {
    if (!dirReady) {
      dirReady = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    await dirReady;

    const tool = safeToolName(metadata.toolName);
    let filename: string;
    if (metadata.toolCallId) {
      filename = `${tool}-${metadata.toolCallId}.md`;
    } else {
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
      const idx = metadata.messageIndex ?? 0;
      filename = `${tool}-msg${idx}-${hash}.md`;
    }

    const fullPath = join(dir, filename);
    await writeFile(fullPath, content, 'utf-8');
    return fullPath;
  };
}

export async function listSessions(): Promise<SessionMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];

  for (const entry of entries) {
    try {
      const metaRaw = await readFile(join(SESSIONS_DIR, entry, 'meta.json'), 'utf-8');
      const meta: unknown = JSON.parse(metaRaw);
      const parsedMeta = parseSessionMeta(meta);
      if (parsedMeta) sessions.push(parsedMeta);
    } catch {
      // Skip invalid session directories
    }
  }

  // Sort by most recently updated first
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

/**
 * Create a debounced save function that batches rapid save calls.
 */
export function createDebouncedSaver(
  sessionId: string,
  delayMs: number = 500,
): {
  save: (history: unknown[], meta: SessionMeta) => void;
  flush: () => Promise<void>;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingHistory: unknown[] | null = null;
  let pendingMeta: SessionMeta | null = null;

  const doSave = async (): Promise<void> => {
    if (pendingHistory && pendingMeta) {
      await saveSession(sessionId, pendingHistory, pendingMeta);
      pendingHistory = null;
      pendingMeta = null;
    }
  };

  return {
    save(history: unknown[], meta: SessionMeta): void {
      pendingHistory = history;
      pendingMeta = meta;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        doSave().catch(() => {
          // Swallow save errors silently
        });
      }, delayMs);
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await doSave();
    },
  };
}
