import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SessionUsage } from '@animus-labs/cortex';

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
}

export interface SavedSession {
  meta: SessionMeta;
  history: unknown[];
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

  await Promise.all([
    writeFile(join(dir, 'history.json'), JSON.stringify(history)),
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
