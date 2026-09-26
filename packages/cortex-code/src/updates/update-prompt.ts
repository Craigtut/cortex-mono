/**
 * The interactive "update available" overlay and the upgrade it can start.
 */

import { SelectList, type SelectItem } from '@earendil-works/pi-tui';
import type { App } from '../tui/app.js';
import { OverlayBox } from '../tui/overlay-box.js';
import { selectListTheme } from '../tui/theme.js';
import type { FileSessionActivityReporter } from '../activity/session-activity.js';
import { dismissVersion, type UpdateInfo } from './checker.js';
import { runNpmUpgrade } from './upgrade.js';

export interface UpdatePromptDeps {
  getApp: () => Pick<App, 'tui' | 'focusEditor' | 'stop'> | null;
  activity: Pick<FileSessionActivityReporter, 'recordDone' | 'recordError' | 'flush'>;
  /** Drains session writes that must land before the process exits. */
  flushTranscript: () => Promise<void>;
}

export class UpdatePrompt {
  /** Guards against stacking a second overlay (startup + /update, or double /update). */
  private open = false;

  constructor(private readonly deps: UpdatePromptDeps) {}

  /**
   * Show the overlay. The user can update now (runs npm and exits) or skip
   * this version (recorded so it won't prompt again until a newer version
   * ships).
   */
  async show(info: UpdateInfo): Promise<void> {
    const app = this.deps.getApp();
    // Ignore if no TUI, or an update overlay is already showing.
    if (!app || this.open) return;
    this.open = true;
    await new Promise<void>((resolve) => {
      const items: SelectItem[] = [
        {
          value: 'update',
          label: 'Update now',
          description: `Install ${info.packageName}@${info.latestVersion} and restart`,
        },
        {
          value: 'skip',
          label: 'Skip this version',
          description: 'Continue; remind me when a newer version ships',
        },
      ];

      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(
        list,
        `Update available: ${info.currentVersion} → ${info.latestVersion}`,
      );
      const handle = app.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '60%',
        maxHeight: 10,
      });

      // Guard against the SelectList firing onSelect/onCancel more than once
      // (e.g. a rapid double Enter) before the overlay is removed: the "update"
      // branch spawns npm and exits, so a double-fire must not run twice.
      let done = false;
      const finish = async (value: string) => {
        if (done) return;
        done = true;
        handle.hide();
        if (value === 'update') {
          await this.runUpgrade(info); // tears down the TUI and exits the process
          return; // not reached on success
        }
        await dismissVersion(info.latestVersion);
        this.open = false;
        app.focusEditor();
        resolve();
      };

      list.onSelect = (item) => { void finish(item.value); };
      list.onCancel = () => { void finish('skip'); };
    });
  }

  /** Tear down the TUI, run the global npm upgrade, and exit. */
  private async runUpgrade(info: UpdateInfo): Promise<void> {
    const { activity } = this.deps;
    this.deps.getApp()?.stop();
    console.log(`\nUpdating ${info.packageName} to ${info.latestVersion}...\n`);
    const code = await runNpmUpgrade(info.packageName);
    if (code === 0) {
      await activity.recordDone({ code: 0, signal: null, reason: 'upgrade_completed' });
      await activity.flush();
      await this.deps.flushTranscript();
      console.log(`\n✓ Updated to ${info.latestVersion}. Restart with: cortex\n`);
      process.exit(0);
    }
    await activity.recordError(new Error(`Upgrade failed with exit code ${code}`), true);
    await activity.flush();
    console.log(`\nUpdate failed. Run it manually:\n  npm i -g ${info.packageName}@latest\n`);
    process.exit(1);
  }
}
