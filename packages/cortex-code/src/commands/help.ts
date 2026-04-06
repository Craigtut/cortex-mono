import type { Command } from './index.js';
import { getCommands } from './index.js';

export const helpCommand: Command = {
  name: 'help',
  description: 'Show available commands',
  handler: (session) => {
    const app = session.getApp();
    if (!app) return;

    const commands = getCommands();
    const lines = commands.map(cmd => `  /${cmd.name}  ${cmd.description}`);
    app.transcript.addNotification('Available Commands', lines.join('\n'));
  },
};
