/**
 * Container detection heuristics.
 *
 * When Cortex Code already runs inside a container or similar isolated
 * environment, the OS sandbox stacks a second boundary that adds friction
 * (loopback, mounts) without adding much containment. We detect the common
 * markers so the session can RECOMMEND `/sandbox off`. Detection is heuristic
 * by nature, so callers must only surface a recommendation, never auto-disable.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ContainerDetection {
  inContainer: boolean;
  /** Which heuristic fired (e.g. "/.dockerenv", "cgroup:docker"), or null. */
  marker: string | null;
}

export interface DetectContainerOptions {
  /** Filesystem root to probe. Defaults to '/'. Tests point this at a fixture dir. */
  rootDir?: string;
  /** Environment to inspect. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Marker files dropped by container runtimes at the filesystem root. */
const MARKER_FILES: ReadonlyArray<{ relative: string[]; marker: string }> = [
  { relative: ['.dockerenv'], marker: '/.dockerenv' },
  { relative: ['run', '.containerenv'], marker: '/run/.containerenv' },
];

/** Runtime names that appear in /proc/1/cgroup when PID 1 is containerized. */
const CGROUP_CONTAINER_RE = /docker|containerd|kubepods|podman|lxc/i;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort check for whether this process runs inside a container. Checks,
 * in order: the `container` env var (set by podman, systemd-nspawn, and some
 * OCI runtimes), the Kubernetes service env, runtime marker files, and the
 * cgroup of PID 1. Never throws; an unreadable marker just does not match.
 */
export async function detectContainer(
  options: DetectContainerOptions = {},
): Promise<ContainerDetection> {
  const root = options.rootDir ?? '/';
  const env = options.env ?? process.env;

  const containerEnv = env['container'];
  if (containerEnv) {
    return { inContainer: true, marker: `env:container=${containerEnv}` };
  }
  if (env['KUBERNETES_SERVICE_HOST']) {
    return { inContainer: true, marker: 'env:KUBERNETES_SERVICE_HOST' };
  }

  for (const { relative, marker } of MARKER_FILES) {
    if (await fileExists(join(root, ...relative))) {
      return { inContainer: true, marker };
    }
  }

  try {
    const cgroup = await readFile(join(root, 'proc', '1', 'cgroup'), 'utf-8');
    const match = cgroup.match(CGROUP_CONTAINER_RE);
    if (match) {
      return { inContainer: true, marker: `cgroup:${match[0].toLowerCase()}` };
    }
  } catch {
    // Not Linux, or /proc unreadable: fall through to "not a container".
  }

  return { inContainer: false, marker: null };
}
