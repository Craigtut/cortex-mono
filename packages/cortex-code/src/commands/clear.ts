import type { Command } from './index.js';

export const clearCommand: Command = {
  name: 'clear',
  description: 'Clear transcript',
  handler: (session) => {
    const app = session.getApp();
    if (!app) return;
    app.transcript.clear();
    // Fresh start: drop the captured intent so the tab is renamed by the next
    // prompt rather than lingering on the prior topic.
    session.resetTitle();
  },
};
