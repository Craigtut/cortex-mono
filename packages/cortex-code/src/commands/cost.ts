import type { Command } from './index.js';

export const costCommand: Command = {
  name: 'cost',
  description: 'Show token usage and cost summary',
  handler: (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    const currentContextTokens = Math.max(
      agent.currentContextTokenCount,
      agent.estimateCurrentContextTokens(),
    );
    const contextWindow = agent.effectiveContextWindow;
    const ctxUsage = (currentContextTokens / 1000).toFixed(1);
    const limit = (contextWindow / 1000).toFixed(0);
    const percentage = contextWindow > 0 ? ((currentContextTokens / contextWindow) * 100).toFixed(1) : '0';

    const usage = agent.getSessionUsage();

    // Cache hit rate: what percentage of total input tokens were served from cache
    const totalInput = usage.tokens.input + usage.tokens.cacheRead;
    const cacheHitRate = totalInput > 0
      ? ((usage.tokens.cacheRead / totalInput) * 100).toFixed(1)
      : '0.0';

    const lines = [
      `Current context usage: ${ctxUsage}k / ${limit}k (${percentage}%)`,
      `Turns: ${usage.totalTurns}`,
      usage.totalCost > 0 ? `Estimated cost: $${usage.totalCost.toFixed(4)}` : '',
      totalInput > 0 ? `Cache hit rate: ${cacheHitRate}%` : '',
      `Context window: ${limit}k tokens`,
    ].filter(Boolean);

    app.transcript.addNotification('Cost Summary', lines.join('\n'));
  },
};
