/**
 * Per-workspace sandbox settings: the remembered trust rung (the folder-trust
 * default) and one-time notice flags. Stored under the `sandbox` top-level key
 * of the same workspace settings file the permission rules and network domain
 * grants use, with the same read-modify-write pattern (each store only touches
 * its own key, serialized through the shared per-path write lock) and the same
 * 0600 permissions.
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SandboxRung } from '@animus-labs/cortex';
import { withFileLock } from '../utils/file-lock.js';

const RUNGS: readonly string[] = ['restricted', 'workspace', 'trusted', 'off'];

interface PersistedSandboxSettings {
  rung?: unknown;
  containerNoticeShown?: unknown;
}

export class SandboxSettingsStore {
  private rung: SandboxRung | undefined;
  private containerNoticeShown = false;

  constructor(private readonly settingsPath: string) {}

  async load(): Promise<void> {
    try {
      const content = await readFile(this.settingsPath, 'utf-8');
      const settings = JSON.parse(content) as { sandbox?: PersistedSandboxSettings };
      const rung = settings.sandbox?.rung;
      this.rung = typeof rung === 'string' && RUNGS.includes(rung) ? (rung as SandboxRung) : undefined;
      this.containerNoticeShown = settings.sandbox?.containerNoticeShown === true;
    } catch {
      this.rung = undefined;
      this.containerNoticeShown = false;
    }
  }

  /** The remembered rung for this workspace, or undefined on first open. */
  getRung(): SandboxRung | undefined {
    return this.rung;
  }

  async setRung(rung: SandboxRung): Promise<void> {
    this.rung = rung;
    await this.persist();
  }

  /** Whether the "running inside a container" recommendation was already shown. */
  isContainerNoticeShown(): boolean {
    return this.containerNoticeShown;
  }

  async markContainerNoticeShown(): Promise<void> {
    this.containerNoticeShown = true;
    await this.persist();
  }

  private persist(): Promise<void> {
    return withFileLock(this.settingsPath, async () => {
      let settings: Record<string, unknown>;
      try {
        settings = JSON.parse(await readFile(this.settingsPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        settings = {};
      }
      const sandbox =
        typeof settings['sandbox'] === 'object' && settings['sandbox'] !== null
          ? (settings['sandbox'] as Record<string, unknown>)
          : {};
      if (this.rung !== undefined) sandbox['rung'] = this.rung;
      if (this.containerNoticeShown) sandbox['containerNoticeShown'] = true;
      settings['sandbox'] = sandbox;

      await mkdir(dirname(this.settingsPath), { recursive: true, mode: 0o700 });
      await writeFile(this.settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
      await chmod(this.settingsPath, 0o600);
    });
  }
}
