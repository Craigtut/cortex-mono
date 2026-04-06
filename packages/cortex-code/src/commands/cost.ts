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
    const usage = (tokenCount / 1000).toFixed(1);
    const limit = (contextWindow / 1000).toFixed(0);
    const percentage = contextWindow > 0 ? ((tokenCount / contextWindow) * 100).toFixed(1) : '0';

    const budgetGuard = agent.getBudgetGuard();
    const turns = budgetGuard.getTurnCount();
    const cost = budgetGuard.getTotalCost();

    const lines = [
      `Token usage: ${usage}k / ${limit}k (${percentage}%)`,
      `Turns: ${turns}`,
      cost > 0 ? `Estimated cost: $${cost.toFixed(4)}` : '',
      `Context window: ${limit}k tokens`,
    ].filter(Boolean);

    app.transcript.addNotification('Cost Summary', lines.join('\n'));
  },
};
