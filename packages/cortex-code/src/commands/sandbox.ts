/**
 * /sandbox: the trust ladder command and effective-policy inspector.
 *
 * - `/sandbox` or `/sandbox status`: print the real, resolved policy (rung,
 *   backend, per-dimension enforcement, writable roots, denied reads, allowed
 *   domains and grants, degradations). Ground truth, not the requested config.
 * - `/sandbox <rung>`: change the rung for this session and remember it for
 *   this workspace. Rung changes are a HUMAN action only: this slash command
 *   is their sole entry point, and the model cannot invoke slash commands.
 *
 * See docs/cortex/sandboxing.md (the trust ladder and Transparency sections).
 */

import { SelectList, type SelectItem } from '@earendil-works/pi-tui';
import type { Command } from './index.js';
import { selectListTheme } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';
import type { SandboxPolicy, SandboxRung, SandboxStatus } from '@animus-labs/cortex';

const RUNGS: readonly SandboxRung[] = ['restricted', 'workspace', 'trusted', 'off'];

/** One-line behavior summary per contained rung, shown after a change. */
const RUNG_SUMMARIES: Record<Exclude<SandboxRung, 'off'>, string> = {
  restricted: 'Read-only filesystem, no network.',
  workspace: 'Writes contained to the workspace, network limited to allowed domains.',
  trusted: 'Writes contained to the workspace, network open.',
};

/** Everything the status report needs, decoupled from Session for testability. */
export interface SandboxStatusView {
  rung: SandboxRung;
  /** False when config pins the sandbox off (sandbox.enabled=false). */
  configEnabled: boolean;
  status: SandboxStatus | undefined;
  policy: SandboxPolicy | undefined;
  grants: { persisted: readonly string[]; session: readonly string[] };
}

/** Render the effective policy as the multi-line body of a notification. */
export function formatSandboxStatus(view: SandboxStatusView): string {
  if (view.rung === 'off') {
    const lines = [
      view.configEnabled
        ? 'Rung: off (no containment)'
        : 'Rung: off (disabled by config: sandbox.enabled=false)',
      'Shell commands and network run with full user access.',
    ];
    if (view.configEnabled) {
      lines.push('Use /sandbox workspace to re-enable containment.');
    }
    return lines.join('\n');
  }

  const policy = view.policy;
  if (!policy) {
    // Contained rung with no recorded policy should not happen; stay honest
    // rather than inventing details.
    return `Rung: ${view.rung} (policy unavailable)\nContainment state unknown; treat as not enforced.`;
  }

  const status = view.status;
  const enforced = status !== undefined && status.backend !== 'none';
  const networkModeLabel =
    policy.network.mode === 'deny'
      ? 'all egress blocked'
      : policy.network.mode === 'full'
        ? 'open, proxied'
        : 'allowlist';

  const lines: string[] = [
    `Rung: ${view.rung}${enforced ? '' : ' (NOT ENFORCED)'}`,
    `Backend: ${status?.backend ?? 'none'}`,
    `Filesystem: ${status?.filesystem ?? 'none'}`,
    `Network: ${status?.network ?? 'none'} (${networkModeLabel})`,
  ];

  if (policy.filesystem.writableRoots.length === 0) {
    lines.push('Writable roots: none (read-only)');
  } else {
    lines.push('Writable roots:');
    for (const root of policy.filesystem.writableRoots) lines.push(`  ${root}`);
  }
  lines.push(`Denied reads: ${policy.filesystem.denyRead.length} paths (secrets and credential stores)`);
  lines.push(`Denied writes: ${policy.filesystem.denyWrite.length} paths (agent config, shell rc files, .git internals)`);

  if (policy.network.mode === 'deny') {
    lines.push('Allowed domains: none');
  } else if (policy.network.mode === 'full') {
    lines.push('Allowed domains: all (trusted rung)');
  } else {
    lines.push(`Allowed domains: ${policy.network.allowedDomains.length} pre-approved (seeded registries + config)`);
    const grants = [
      ...view.grants.persisted.map((d) => `${d} (always)`),
      ...view.grants.session.map((d) => `${d} (session)`),
    ];
    lines.push(grants.length > 0 ? `Granted domains: ${grants.join(', ')}` : 'Granted domains: none');
  }

  const degradations = status?.degradations ?? [];
  if (degradations.length === 0) {
    lines.push('Degradations: none');
  } else {
    lines.push('Degradations:');
    for (const d of degradations) lines.push(`  ${d}`);
  }

  return lines.join('\n');
}

export const sandboxCommand: Command = {
  name: 'sandbox',
  description: 'Show sandbox status or change the trust rung (restricted|workspace|trusted|off)',
  handler: async (session, args) => {
    const app = session.getApp();
    if (!app) return;

    const arg = (args[0] ?? '').toLowerCase();

    if (arg === '' || arg === 'status') {
      app.transcript.addNotification(
        'Sandbox',
        formatSandboxStatus({
          rung: session.getSandboxRung(),
          configEnabled: session.isSandboxConfigEnabled(),
          status: session.getSandboxStatus(),
          policy: session.getSandboxPolicy(),
          grants: session.getNetworkGrantInfo(),
        }),
      );
      return;
    }

    if (!(RUNGS as readonly string[]).includes(arg)) {
      app.transcript.addNotification(
        'Sandbox',
        `Unknown option "${arg}". Usage: /sandbox [status | restricted | workspace | trusted | off]`,
      );
      return;
    }
    const rung = arg as SandboxRung;

    const apply = async (): Promise<void> => {
      const result = await session.setSandboxRung(rung);
      if (!result.changed) {
        app.transcript.addNotification('Sandbox', result.reason ?? 'No change.');
        return;
      }
      if (rung === 'off') {
        app.transcript.addNotification(
          'Sandbox',
          'Containment is off. Shell commands and network run with full user access.\nRe-enable with /sandbox workspace.',
        );
        return;
      }
      // Honest confirmation: say what is actually enforced, not what was asked.
      const status: SandboxStatus | undefined = session.getSandboxStatus();
      if (!status || status.backend === 'none') {
        const reason = status?.degradations.join('; ');
        app.transcript.addNotification(
          'Sandbox',
          `Rung set to ${rung}, but OS enforcement is unavailable on this host` +
            (reason ? `:\n  ${reason}` : '.') +
            '\nNetwork policy still gates WebFetch; shell commands run uncontained.',
        );
        return;
      }
      app.transcript.addNotification(
        'Sandbox',
        `Rung set to ${rung} (${status.backend}). ${RUNG_SUMMARIES[rung]}`,
      );
    };

    // Turning containment fully off is the one direction with real blast
    // radius, so it confirms first (mirroring /yolo's first activation).
    // Every other rung change applies immediately.
    if (rung === 'off' && session.getSandboxRung() !== 'off') {
      const items: SelectItem[] = [
        { value: 'confirm', label: 'Turn sandbox off', description: 'No containment: full user access' },
        { value: 'cancel', label: 'Cancel' },
      ];
      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(list, 'Sandbox Off');
      const handle = app.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '50%',
        maxHeight: 8,
      });
      return new Promise<void>((resolve) => {
        list.onSelect = (item) => {
          handle.hide();
          app.focusEditor();
          if (item.value === 'confirm') {
            void apply().then(resolve);
          } else {
            resolve();
          }
        };
        list.onCancel = () => {
          handle.hide();
          app.focusEditor();
          resolve();
        };
      });
    }

    await apply();
  },
};
