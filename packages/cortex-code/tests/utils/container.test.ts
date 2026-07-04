import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectContainer } from '../../src/utils/container.js';

/**
 * Hermetic by construction: every probe is pointed at a throwaway fixture root
 * and an explicit env object, so the host machine (which may itself be a
 * container in CI) never influences the result.
 */
function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'container-root-'));
}

const noEnv: Record<string, string | undefined> = {};

describe('detectContainer', () => {
  it('reports not-a-container when no markers exist', async () => {
    const root = makeRoot();
    expect(await detectContainer({ rootDir: root, env: noEnv })).toEqual({
      inContainer: false,
      marker: null,
    });
  });

  it('detects the /.dockerenv marker file', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, '.dockerenv'), '');
    expect(await detectContainer({ rootDir: root, env: noEnv })).toEqual({
      inContainer: true,
      marker: '/.dockerenv',
    });
  });

  it('detects the podman /run/.containerenv marker file', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'run'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run', '.containerenv'), '');
    expect(await detectContainer({ rootDir: root, env: noEnv })).toEqual({
      inContainer: true,
      marker: '/run/.containerenv',
    });
  });

  it.each([
    ['12:pids:/docker/0123456789abcdef', 'cgroup:docker'],
    ['0::/system.slice/containerd.service/kubepods-pod1234', 'cgroup:containerd'],
    ['0::/kubepods.slice/kubepods-besteffort.slice', 'cgroup:kubepods'],
    ['10:cpuset:/lxc/mycontainer', 'cgroup:lxc'],
  ])('detects container runtimes in /proc/1/cgroup (%s)', async (content, marker) => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'proc', '1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proc', '1', 'cgroup'), content);
    expect(await detectContainer({ rootDir: root, env: noEnv })).toEqual({
      inContainer: true,
      marker,
    });
  });

  it('does not match a host-style cgroup', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'proc', '1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proc', '1', 'cgroup'), '0::/init.scope');
    expect((await detectContainer({ rootDir: root, env: noEnv })).inContainer).toBe(false);
  });

  it('detects the container env var (podman, systemd-nspawn)', async () => {
    const root = makeRoot();
    const result = await detectContainer({ rootDir: root, env: { container: 'podman' } });
    expect(result).toEqual({ inContainer: true, marker: 'env:container=podman' });
  });

  it('detects the Kubernetes service env', async () => {
    const root = makeRoot();
    const result = await detectContainer({
      rootDir: root,
      env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
    });
    expect(result).toEqual({ inContainer: true, marker: 'env:KUBERNETES_SERVICE_HOST' });
  });

  it('ignores an empty container env var', async () => {
    const root = makeRoot();
    const result = await detectContainer({ rootDir: root, env: { container: '' } });
    expect(result.inContainer).toBe(false);
  });
});
