/**
 * The resolution report: what a CortexAgent assembly actually resolved to,
 * where that differs from what the consumer asked for.
 *
 * Cortex resolves a configuration at assembly that can quietly differ from
 * the consumer's request. Duplex on a provider Cortex cannot enumerate
 * assembles with talker = reasoner, which looks healthy, passes every test,
 * and delivers none of the latency benefit the architecture exists for. A
 * cross-provider utilityModel is skipped rather than applied to the talker.
 * A sandbox with an unwired egress resolver fails closed and voices nothing.
 * Each of those was reported through `logger.warn` alone, which is the wrong
 * surface four times over: the logger defaults to NOOP_LOGGER so an unwired
 * consumer gets nothing; the warning fires during create(), before a consumer
 * has any UI to put it in; it is prose, so a consumer cannot render it in its
 * own idiom; and it is unqueryable afterwards, so nothing can answer "is my
 * duplex actually duplex?" at any later point.
 *
 * So: notes are the source, and every other surface derives from them. The
 * facade emits one `logger.warn` and one `lifecycle` session-log entry per
 * note, both built from the note itself, so a log line and the report cannot
 * describe the same fact differently. Adding a condition means adding a note
 * here; it reaches all three surfaces by construction.
 */

import type { CortexModel } from './model-wrapper.js';

/**
 * How much a note matters.
 *
 * - `degraded`: the consumer asked for something and is not getting it, or
 *   the architecture is not delivering its premise. Something is worse than
 *   the consumer has reason to believe.
 * - `info`: a default is in force that they may want to change. Nothing is
 *   broken; the exposure is simply not the one they might assume.
 */
export type ResolutionSeverity = 'degraded' | 'info';

/**
 * Stable machine-readable note codes. A closed union rather than a bare
 * string: a consumer renders per code, and an exhaustive switch over this is
 * how it finds out at compile time that Cortex added a condition.
 */
export const RESOLUTION_NOTE_CODES = [
  'talker-model-fallback',
  'talker-utility-model-skipped',
  'network-resolver-unwired',
  'duplex-cost-cap-unset',
] as const;

export type ResolutionNoteCode = (typeof RESOLUTION_NOTE_CODES)[number];

/**
 * One resolved-differently fact about this assembly.
 *
 * The three text fields are three lengths of the same statement, so a
 * consumer picks by the space it has rather than by re-deriving wording:
 * `summary` fits a status bar, `detail` explains it, `remedy` says what to
 * set. `data` carries the same facts structurally, so a consumer that wants
 * its own wording never has to parse the prose.
 */
export interface ResolutionNote {
  /** Stable identity of the condition. */
  code: ResolutionNoteCode;
  severity: ResolutionSeverity;
  /** One line, renderable in a status bar. */
  summary: string;
  /** The full explanation: what was resolved, and what that costs. */
  detail: string;
  /** What to set to fix it. */
  remedy: string;
  /** The same facts structurally, for a consumer rendering its own wording. */
  data: Record<string, unknown>;
}

/** Deep-enough copy: notes are handed out and logged, never shared live. */
export function cloneResolutionNote(note: ResolutionNote): ResolutionNote {
  return { ...note, data: { ...note.data } };
}

/**
 * The log line for a note. One derivation, used for every note, so the text
 * a headless consumer greps for is the text the report carries.
 */
export function resolutionWarnText(note: ResolutionNote): string {
  return `${note.detail} ${note.remedy}`;
}

/**
 * The assembled facts the notes are read off. Deliberately the *resolved*
 * state (the models the loops actually hold, the cap the aggregate guard was
 * actually built with) rather than the config that fed it: a note derived
 * from the input would still claim a fallback that a later change to the
 * assembly rules had removed.
 */
export interface AssemblyResolution {
  mode: 'duplex' | 'passthrough';
  /** `talker.model` as the consumer supplied it (undefined means auto). */
  requestedTalkerModel: CortexModel | undefined;
  /** The model the talker loop holds; null in passthrough. */
  talkerModel: CortexModel | null;
  /** The model the reasoner loop holds. */
  reasonerModel: CortexModel;
  /** `utilityModel` as the consumer supplied it. */
  configuredUtilityModel: CortexModel | 'default' | undefined;
  /** The utility model the talker loop resolved to; null in passthrough. */
  talkerUtilityModel: CortexModel | null;
  /**
   * The aggregate guard's cost cap (Infinity when uncapped); null in
   * passthrough, which has no aggregate guard.
   */
  aggregateCostCap: number | null;
  /** `budgetGuard.maxCost`, which is per prompt and bounds no session. */
  perPromptMaxCost: number | undefined;
}

/**
 * Every note this assembly earns, computed once. Eager by construction: the
 * caller passes the assembled state, so nothing here can observe a
 * post-assembly mutation and report it as an assembly fact.
 */
export function collectAssemblyResolutionNotes(
  resolution: AssemblyResolution,
): ResolutionNote[] {
  const notes: ResolutionNote[] = [];
  const { talkerModel, reasonerModel } = resolution;

  if (
    talkerModel !== null &&
    resolution.requestedTalkerModel === undefined &&
    talkerModel.provider === reasonerModel.provider &&
    talkerModel.modelId === reasonerModel.modelId
  ) {
    notes.push({
      code: 'talker-model-fallback',
      severity: 'degraded',
      summary: `Talker is running the primary model "${talkerModel.modelId}": duplex adds no speed.`,
      detail:
        `No fast model resolved for provider "${talkerModel.provider}"; ` +
        `the talker will run on the primary model "${talkerModel.modelId}".`,
      remedy: "Set talker.model to a fast model, or use mode: 'passthrough'.",
      data: {
        provider: talkerModel.provider,
        talkerModelId: talkerModel.modelId,
        reasonerModelId: reasonerModel.modelId,
      },
    });
  }

  const configuredUtility = resolution.configuredUtilityModel;
  const talkerUtility = resolution.talkerUtilityModel;
  if (
    talkerModel !== null &&
    talkerUtility !== null &&
    configuredUtility !== undefined &&
    configuredUtility !== 'default' &&
    (configuredUtility.provider !== talkerUtility.provider ||
      configuredUtility.modelId !== talkerUtility.modelId)
  ) {
    notes.push({
      code: 'talker-utility-model-skipped',
      severity: 'degraded',
      summary: `Talker is not using the configured utilityModel "${configuredUtility.modelId}".`,
      detail:
        `utilityModel "${configuredUtility.modelId}" is a ` +
        `"${configuredUtility.provider}" model, and the talker runs on ` +
        `"${talkerModel.modelId}" ("${talkerModel.provider}"), which rejects a ` +
        'utility model from another provider. The talker will run its ' +
        'observational memory on its own auto-resolved utility model instead; ' +
        'the reasoner uses the one you set.',
      remedy:
        'To have both loops use it, set talker.model to a ' +
        `"${configuredUtility.provider}" model.`,
      data: {
        configuredUtilityModelId: configuredUtility.modelId,
        configuredUtilityProvider: configuredUtility.provider,
        talkerModelId: talkerModel.modelId,
        talkerProvider: talkerModel.provider,
        talkerUtilityModelId: talkerUtility.modelId,
      },
    });
  }

  if (resolution.aggregateCostCap !== null && !Number.isFinite(resolution.aggregateCostCap)) {
    notes.push({
      code: 'duplex-cost-cap-unset',
      severity: 'info',
      summary: 'No session-level cost ceiling: duplex spend is unbounded.',
      detail:
        'duplex has no aggregate spend cap. budgetGuard.maxCost is per prompt on the ' +
        'reasoner and does not bound the session, so both resident loops, sub-agents, ' +
        'quick lookups and observational spend accumulate without a ceiling.',
      remedy: 'Set duplex.maxTotalCost.',
      data: {
        perPromptMaxCost: resolution.perPromptMaxCost ?? null,
      },
    });
  }

  return notes;
}

/**
 * The one note that is not an assembly fact: nobody took the egress resolver
 * to wire into the sandbox. It cannot be known at assembly (a consumer wires
 * it on the line after create() returns), so it is recorded when the check
 * first runs, through the same note pathway as the rest.
 */
export function networkResolverUnwiredNote(mode: 'duplex' | 'passthrough'): ResolutionNote {
  return {
    code: 'network-resolver-unwired',
    severity: 'degraded',
    summary: 'Shell egress asks are unwired: sandbox network access fails closed.',
    detail:
      'sandbox and resolveNetworkAccess are configured but getNetworkAccessResolver() ' +
      'was never called: shell egress asks bypass the permission broker and fail closed.',
    remedy:
      "Wire getNetworkAccessResolver() into the SandboxProvider's network ask callback.",
    data: { mode, observedAt: 'first-prompt' },
  };
}
