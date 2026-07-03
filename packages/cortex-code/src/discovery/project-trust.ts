/**
 * Project trust-on-first-use for project-local executable/injectable content.
 *
 * A cloned or opened project can carry content that Cortex Code would execute
 * or inject on the user's behalf without them ever asking for it:
 *   - `.cortex/mcp.json`   spawns MCP server processes,
 *   - `.cortex/hooks.json` spawns lifecycle-hook subprocesses,
 *   - `.cortex/skills/*`   registers model-invocable skills whose SKILL.md
 *                          bodies can run shell on load.
 *
 * This module gives all three the same trust-on-first-use gate the MCP flow
 * already had: the first time a project's content of a given KIND is seen (or
 * whenever it changes), the caller prompts the user before loading/running it.
 * Until approved, that content stays inert. Global content (`~/.cortex/*`) is
 * user-authored and always trusted; it never reaches this module.
 *
 * Persistence mirrors the old `trusted-mcp.json` store: a JSON map of project
 * path to the SHA-256 hashes of each trusted content kind, written 0600.
 *
 * TOCTOU note: callers pass the EXACT content they are about to act on / show
 * the user into both `checkProjectTrust` and `recordProjectTrust`. Trust is
 * decided and recorded against those identical bytes, never re-read from disk
 * at approval time, so a file swapped between the prompt and the click cannot
 * launder itself into the trust store.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** Kinds of project-local executable/injectable content the gate protects. */
export type ProjectTrustKind = 'mcp' | 'hooks' | 'skills';

/** Resolved lazily (not at import time) so tests can redirect the home dir. */
function trustStorePath(): string {
  return join(homedir(), '.cortex', 'trusted-content.json');
}

/** Per-project record: SHA-256 hash of the last-approved content per kind. */
type ProjectTrustEntry = Partial<Record<ProjectTrustKind, string>>;

interface TrustStore {
  /** Map of project path to its per-kind approved content hashes. */
  projects: Record<string, ProjectTrustEntry>;
}

async function loadTrustStore(): Promise<TrustStore> {
  try {
    const raw = await readFile(trustStorePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['projects'] === 'object' &&
      (parsed as Record<string, unknown>)['projects'] !== null
    ) {
      return parsed as TrustStore;
    }
  } catch {
    // File doesn't exist or is corrupt: treat as an empty store.
  }
  return { projects: {} };
}

async function saveTrustStore(store: TrustStore): Promise<void> {
  await mkdir(dirname(trustStorePath()), { recursive: true });
  await writeFile(trustStorePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
  await chmod(trustStorePath(), 0o600);
}

/** SHA-256 hex digest of a content signature string. */
export function hashTrustContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Whether the given content for (cwd, kind) is already trusted.
 *
 * `content === null` means "there is nothing of this kind to trust" and always
 * returns true (no prompt). Otherwise the content's hash must equal the stored,
 * previously-approved hash for this project + kind.
 */
export async function checkProjectTrust(
  cwd: string,
  kind: ProjectTrustKind,
  content: string | null,
): Promise<boolean> {
  if (content === null) return true;
  const store = await loadTrustStore();
  return store.projects[cwd]?.[kind] === hashTrustContent(content);
}

/**
 * Record that the user approved this EXACT content for (cwd, kind). Callers
 * must pass the same content string they passed to `checkProjectTrust` (and
 * displayed to the user), never a fresh read, so the recorded hash matches what
 * was actually shown.
 */
export async function recordProjectTrust(
  cwd: string,
  kind: ProjectTrustKind,
  content: string,
): Promise<void> {
  const store = await loadTrustStore();
  const entry = store.projects[cwd] ?? {};
  entry[kind] = hashTrustContent(content);
  store.projects[cwd] = entry;
  await saveTrustStore(store);
}
