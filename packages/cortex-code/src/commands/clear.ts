import type { Command } from './index.js';

export const clearCommand: Command = {
  name: 'clear',
  description: 'Clear transcript',
  handler: (session) => {
    const app = session.getApp();
    if (!app) return;
    app.transcript.clear();
  },
};
