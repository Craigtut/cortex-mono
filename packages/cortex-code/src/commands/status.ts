import type { ResolutionNote } from '@animus-labs/cortex';
import type { Command } from './index.js';

/**
 * What this session actually resolved to, where that differs from what was
 * configured.
 *
 * The footer carries a dim marker when something is degraded, which answers
 * "is anything off?" and deliberately nothing more. This is the "what?" half,
 * on demand: the same notes, with the detail and the remedy the framework
 * supplies. Deliberately not a startup banner or a per-turn notification,
 * because the cost of missing one of these is a slower or pricier session
 * rather than lost work, and a warning on every session stops being read.
 */
export const statusCommand: Command = {
  name: 'status',
  description: 'Show what this session resolved to, and any degraded settings',
  handler: (session) => {
    const app = session.getApp();
    if (!app) return;

    const notes = session.getResolutionReport() as ResolutionNote[];
    if (notes.length === 0) {
      app.transcript.addNotification(
        'Session Status',
        'Everything resolved as configured.',
      );
      return;
    }

    app.transcript.addNotification('Session Status', notes.map(renderNote).join('\n\n'));
  },
};

/**
 * One note as three lines: what, why it matters, what to set. The framework
 * writes all three, so wording stays consistent with the log lines derived
 * from the same note rather than being paraphrased here.
 */
function renderNote(note: ResolutionNote): string {
  // A dagger for degraded and a middle dot for info, matching the footer's
  // marker so the two surfaces read as the same vocabulary.
  const mark = note.severity === 'degraded' ? '†' : '·';
  return [
    `${mark} ${note.summary}`,
    `  ${note.detail}`,
    `  Fix: ${note.remedy}`,
  ].join('\n');
}
