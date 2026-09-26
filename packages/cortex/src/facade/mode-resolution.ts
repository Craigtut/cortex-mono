/**
 * Facade mode resolution: which mode an assembly runs, decided once before
 * any loop exists, because the loops are built from it (decisions.md D21).
 *
 * Duplex only pays off when the talker's request runs while the reasoner's
 * is in flight. That fails only when both loops reach one backend that
 * cannot serve them at once, so an omitted mode resolves to passthrough
 * exactly then and to duplex otherwise (model-backend.ts owns the test).
 * An explicit `mode` always wins.
 */

import { resolveUtilityModels } from '../agent-loop/model-settings.js';
import type { PiModel } from '../agent-loop/pi-agent.js';
import { servedConcurrently } from '../model-backend.js';
import { describeModel, isCortexModel, unwrapModel } from '../model-wrapper.js';
import type { CortexModel, ModelDescription } from '../model-wrapper.js';
import type { CortexAgentMode, ResolvedCortexAgentConfig } from './config.js';

/** The mode an assembly runs and what it was decided from. */
export type ModeResolution =
  | { mode: CortexAgentMode; requested: CortexAgentMode }
  | {
    mode: CortexAgentMode;
    /** Omitted by the consumer: resolved from the models below. */
    requested: undefined;
    reasoner: ModelDescription;
    /** The talker duplex would run; null when the reasoner model is unusable. */
    talker: ModelDescription | null;
  };

/**
 * The talker model duplex assembly would pick: `talker.model` when pinned,
 * otherwise the reasoner's auto-resolved utility model. Computed with the
 * same function and inputs the assembled reasoner's
 * getAutoResolvedUtilityModel() uses, so the decision describes the talker
 * that assembly then builds.
 */
function defaultTalkerModel(config: ResolvedCortexAgentConfig): CortexModel {
  if (config.talker?.model) return config.talker.model;
  return resolveUtilityModels(
    config.model,
    unwrapModel(config.model) as PiModel,
    config.utilityModel,
  ).utilityModel;
}

export function resolveFacadeMode(config: ResolvedCortexAgentConfig): ModeResolution {
  if (config.mode !== undefined) return { mode: config.mode, requested: config.mode };
  // An unusable model fails in AgentLoop.create with its own error; the
  // decision only has to not throw a different one first.
  if (!isCortexModel(config.model)) {
    return {
      mode: 'passthrough',
      requested: undefined,
      reasoner: { provider: '', endpoint: '', modelId: '', concurrency: 'unknown' },
      talker: null,
    };
  }
  const reasoner = describeModel(config.model);
  const talker = describeModel(defaultTalkerModel(config));
  const mode = servedConcurrently(reasoner, talker) ? 'duplex' : 'passthrough';
  return { mode, requested: undefined, reasoner, talker };
}
