import type { Command } from './index.js';

export const exitCommand: Command = {
  name: 'exit',
  description: 'Exit the application',
  handler: async (session) => {
    await session.shutdown();
  },
};
