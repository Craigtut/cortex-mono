import type { Command } from './index.js';

export const costCommand: Command = {
  name: 'cost',
  description: 'Show token usage and cost summary',
  handler: (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    const tokenCount = agent.sessionTokenCount;
    const contextWindow = agent.effectiveContextWindow;
    const ctxUsage = (tokenCount / 1000).toFixed(1);
    const limit = (contextWindow / 1000).toFixed(0);
    const percentage = contextWindow > 0 ? ((tokenCount / contextWindow) * 100).toFixed(1) : '0';

    const usage = agent.getSessionUsage();

    const lines = [
      `Token usage: ${ctxUsage}k / ${limit}k (${percentage}%)`,
      `Turns: ${usage.totalTurns}`,
      usage.totalCost > 0 ? `Estimated cost: $${usage.totalCost.toFixed(4)}` : '',
      `Context window: ${limit}k tokens`,
    ].filter(Boolean);

    app.transcript.addNotification('Cost Summary', lines.join('\n'));
  },
};
