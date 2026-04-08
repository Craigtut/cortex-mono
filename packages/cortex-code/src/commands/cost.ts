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

    // Total input = uncached + cache reads + cache writes (all tokens sent to the model)
    const totalInput = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite;
    const totalOutput = usage.tokens.output;

    // Cache hit rate: of all input tokens, what percentage were served from cache (cheap)?
    // Denominator includes cacheWrite because those are new writes at full price.
    const cacheHitRate = totalInput > 0
      ? ((usage.tokens.cacheRead / totalInput) * 100).toFixed(1)
      : '0.0';

    const lines = [
      `Current context: ${ctxUsage}k / ${limit}k (${percentage}%)`,
      `Session tokens: ${(totalInput / 1000).toFixed(1)}k in / ${(totalOutput / 1000).toFixed(1)}k out`,
      `Turns: ${usage.totalTurns}`,
      usage.totalCost > 0 ? `Estimated cost: $${usage.totalCost.toFixed(4)}` : '',
      totalInput > 0 ? `Cache hit rate: ${cacheHitRate}%` : '',
    ].filter(Boolean);

    app.transcript.addNotification('Cost Summary', lines.join('\n'));
  },
};
