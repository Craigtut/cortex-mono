/**
 * Update checker: tells npm-global users when a newer Cortex Code is published.
 *
 * Design (the "update-notifier" pattern used by npm, gh, homebrew):
 * - Startup reads a cached result from ~/.cortex/update-state.json (instant,
 *   local) and never blocks on the network.
 * - When the cache is stale, a background fetch refreshes it for the NEXT
 *   launch. This run only ever displays what we already knew, so there is no
 *   startup delay and no mid-render flicker.
 * - A skipped version is remembered per-version: the interactive prompt returns
 *   only when a version newer than the skipped one ships.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PKG_NAME } from '../version.js';
import { log } from '../logger.js';

const STATE_DIR = join(homedir(), '.cortex');
const STATE_PATH = join(STATE_DIR, 'update-state.json');
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME.replace('/', '%2F')}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 3000;

export interface UpdateState {
  /** Epoch ms of the last successful (or attempted) registry check. */
  lastCheckTime: number;
  /** Latest version seen on the registry, or null if never fetched. */
  latestVersion: string | null;
  /** Version the user chose to skip; the prompt stays hidden for it. */
  dismissedVersion: string | null;
}

export interface UpdateInfo {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  /** True when this version has not yet been skipped by the user. */
  shouldPrompt: boolean;
}

const EMPTY_STATE: UpdateState = { lastCheckTime: 0, latestVersion: null, dismissedVersion: null };

/** True when running in CI. Treats CI=false / CI=0 as not-CI. */
function isCI(): boolean {
  const ci = process.env['CI'];
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

export async function readUpdateState(): Promise<UpdateState> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UpdateState>;
    return {
      lastCheckTime: typeof parsed.lastCheckTime === 'number' ? parsed.lastCheckTime : 0,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : null,
      dismissedVersion: typeof parsed.dismissedVersion === 'string' ? parsed.dismissedVersion : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function writeUpdateState(state: UpdateState): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    log.warn('Failed to write update state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Compare two release versions. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Prerelease suffixes (e.g. "-beta.1") are ignored: only the release tuple
 * (major.minor.patch) is compared.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('-')[0]!.split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

/** True when `candidate` is a newer stable release than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  // Never push users onto prerelease builds via the auto-check.
  if (candidate.includes('-')) return false;
  return compareVersions(candidate, current) > 0;
}

/** Fetch the latest published version from the npm registry. Null on any failure. */
export async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the latest version and persist it for the next launch. */
async function refreshUpdateState(prev: UpdateState): Promise<void> {
  const latest = await fetchLatestVersion();
  await writeUpdateState({
    lastCheckTime: Date.now(),
    latestVersion: latest ?? prev.latestVersion,
    dismissedVersion: prev.dismissedVersion,
  });
}

interface ResolveOptions {
  currentVersion: string;
  enabled: boolean;
}

/**
 * Resolve update info from the on-disk cache, triggering a background refresh
 * when the cache is stale. Returns immediately on the cached value: it never
 * awaits the network, so startup is not delayed.
 */
export async function resolveUpdateInfo({ currentVersion, enabled }: ResolveOptions): Promise<UpdateInfo | null> {
  if (!enabled) return null;
  // Skip entirely in non-interactive contexts (pipes, CI): nothing to show.
  if (!process.stdout.isTTY || isCI()) return null;

  const state = await readUpdateState();

  // Refresh in the background when stale. Not awaited: the result lands on disk
  // for the next launch, keeping this run fast and flicker-free.
  if (Date.now() - state.lastCheckTime > CHECK_INTERVAL_MS) {
    void refreshUpdateState(state).catch(() => {});
  }

  const latest = state.latestVersion;
  if (!latest || !isNewer(latest, currentVersion)) return null;

  return {
    packageName: PKG_NAME,
    currentVersion,
    latestVersion: latest,
    shouldPrompt: state.dismissedVersion !== latest,
  };
}

/** Record that the user skipped a specific version. */
export async function dismissVersion(version: string): Promise<void> {
  const state = await readUpdateState();
  await writeUpdateState({ ...state, dismissedVersion: version });
}

/**
 * Force a fresh check, bypassing the cache interval. Used by the /update
 * command. Returns info with `shouldPrompt: true` whenever an update exists.
 */
export async function checkNow(currentVersion: string): Promise<UpdateInfo | null> {
  const latest = await fetchLatestVersion();
  const state = await readUpdateState();
  if (latest) {
    await writeUpdateState({ ...state, lastCheckTime: Date.now(), latestVersion: latest });
  }
  const effective = latest ?? state.latestVersion;
  if (!effective || !isNewer(effective, currentVersion)) return null;
  return {
    packageName: PKG_NAME,
    currentVersion,
    latestVersion: effective,
    shouldPrompt: true,
  };
}
