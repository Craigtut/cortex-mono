import type { Command } from './index.js';

export const compactCommand: Command = {
  name: 'compact',
  description: 'Trigger context compaction',
  handler: async (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    app.showStatusSpinner('Compacting context...');
    try {
      const result = await agent.checkAndRunCompaction();
      app.hideStatusSpinner();
      if (result) {
        const beforeK = (result.tokensBefore / 1000).toFixed(1);
        const afterK = (result.tokensAfter / 1000).toFixed(1);
        app.transcript.addNotification(
          'Compaction Complete',
          `Reduced from ${beforeK}k to ${afterK}k tokens (${result.turnsCompacted} turns compacted)`,
        );
      } else {
        app.transcript.addNotification('Compaction', 'No compaction needed at current token usage.');
      }
    } catch (err) {
      app.hideStatusSpinner();
      app.transcript.addNotification('Compaction Error', err instanceof Error ? err.message : String(err));
    }
  },
};
