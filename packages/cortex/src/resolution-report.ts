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

import { describeModel } from './model-wrapper.js';
import { servedConcurrently } from './model-backend.js';
import type { CortexModel, ModelDescription } from './model-wrapper.js';
import type { ModeResolution } from './facade/mode-resolution.js';
import type { ModeCrossingRestore } from './facade/cross-mode-restore.js';

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
  'mode-resolved-passthrough',
  'duplex-not-concurrent',
  'restore-mode-mismatch',
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
  /** How the mode was decided, before any loop existed. */
  modeResolution: ModeResolution;
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

  const decided = resolution.modeResolution;
  if (decided.requested === undefined && resolution.mode === 'passthrough' && decided.mode === 'duplex') {
    // A setModel() moved a passthrough agent onto models that would resolve
    // to duplex. The mode stays (loops are built from it), so the note says
    // what it is now fixed by rather than repeating a reason that is gone.
    notes.push({
      code: 'mode-resolved-passthrough',
      severity: 'info',
      summary: 'Running passthrough: the mode was resolved at creation, and the current models would run duplex.',
      detail:
        'mode was not set, so it was resolved from the backends when the agent was created. ' +
        'setModel() has since changed the models so that the talker would no longer queue ' +
        'behind the reasoner, but the mode is fixed once the loops are built, so the agent ' +
        'still runs a single loop.',
      remedy: 'Create a new agent to run duplex on these models, or set mode explicitly.',
      data: {
        ...modelData('reasoner', decided.reasoner),
        ...(decided.talker ? modelData('talker', decided.talker) : {}),
        wouldResolveTo: 'duplex',
      },
    });
  } else if (decided.requested === undefined && resolution.mode === 'passthrough') {
    const shared = decided.talker ? describeSharedBackend(decided.talker, decided.reasoner) : null;
    notes.push({
      code: 'mode-resolved-passthrough',
      severity: 'info',
      summary: 'Running passthrough: the talker and reasoner would share a backend not known to serve them concurrently.',
      detail:
        'mode was not set, so it was resolved from the backends. Duplex only helps ' +
        "when the talker's request runs while the reasoner's is in flight, and " +
        `${shared ?? 'the talker model could not be resolved'}, so the agent runs a single loop.`,
      remedy: sharedBackendRemedy(decided.talker, decided.reasoner, "or set mode: 'duplex'."),
      data: {
        ...modelData('reasoner', decided.reasoner),
        ...(decided.talker ? modelData('talker', decided.talker) : {}),
        wouldResolveTo: 'passthrough',
      },
    });
  }

  if (resolution.mode === 'duplex' && talkerModel !== null) {
    const talker = describeModel(talkerModel);
    const reasoner = describeModel(reasonerModel);
    // Two backends always overlap, so only a shared one can queue the
    // talker behind the reasoner.
    if (!servedConcurrently(talker, reasoner)) {
      notes.push({
        code: 'duplex-not-concurrent',
        severity: 'degraded',
        summary: 'Duplex on a shared backend not known to serve concurrent requests: the talker may queue behind the reasoner.',
        detail:
          `mode is 'duplex', but ${describeSharedBackend(talker, reasoner)}. The talker only stays ` +
          'responsive while the reasoner works if that backend serves both requests at once.',
        remedy: sharedBackendRemedy(talker, reasoner, "or use mode: 'passthrough'."),
        data: { ...modelData('talker', talker), ...modelData('reasoner', reasoner) },
      });
    }
  }

  return notes;
}

/** Flat note data for one loop's model (notes are copied one level deep). */
function modelData(role: string, model: ModelDescription): Record<string, unknown> {
  return {
    [`${role}Provider`]: model.provider,
    [`${role}ModelId`]: model.modelId,
    [`${role}Endpoint`]: model.endpoint,
    [`${role}Concurrency`]: model.concurrency,
  };
}

/**
 * The two loops on one backend, as prose ("the talker model "x" and the
 * reasoner model "y" both run on http://localhost:11434, which serves one
 * request at a time").
 */
function describeSharedBackend(talker: ModelDescription, reasoner: ModelDescription): string {
  const where = reasoner.endpoint !== '' ? reasoner.endpoint : `provider "${reasoner.provider}"`;
  const models = talker.modelId === reasoner.modelId
    ? `the talker and the reasoner both run "${reasoner.modelId}" on ${where}`
    : `the talker model "${talker.modelId}" and the reasoner model "${reasoner.modelId}" both run on ${where}`;
  const serial = talker.concurrency === 'serial' || reasoner.concurrency === 'serial';
  return `${models}, which ${serial ? 'serves one request at a time' : 'is not known to serve concurrent requests'}`;
}

/** What to set when one backend serves both loops, ending with the mode option. */
function sharedBackendRemedy(
  talker: ModelDescription | null,
  reasoner: ModelDescription,
  modeOption: string,
): string {
  const ollama = reasoner.provider === 'ollama' || talker?.provider === 'ollama';
  const distinct = talker !== null && talker.modelId !== reasoner.modelId;
  const optIn = ollama
    ? 'If the server does serve them at once (OLLAMA_NUM_PARALLEL above 1' +
      `${distinct ? ', and both models fitting in memory together' : ''}), set parallelRequests: true ` +
      'in createOllamaModel() for both models. '
    : '';
  return `${optIn}${optIn ? 'Otherwise pin' : 'Pin'} talker.model to a model on another backend, ${modeOption}`;
}

/**
 * The one note that is not an assembly fact: nobody took the brokered egress
 * resolver to wire into the sandbox. It cannot be known at assembly (a
 * consumer wires it on the line after create() returns), so it is recorded
 * when the check first runs, through the same note pathway as the rest.
 *
 * Duplex only, and it claims only what is observable. An earlier version
 * asserted that egress "bypasses the permission broker and fails closed",
 * which was an inference about consumer wiring Cortex cannot see: a consumer
 * that hands its sandbox its own decision function answers those asks
 * perfectly well, and the first real consumer did exactly that. What is
 * certain is narrower: the brokered wrapper is reachable only through
 * getNetworkAccessResolver(), so a consumer who never called it cannot have
 * the shell path routed through the broker, and in duplex the broker is what
 * turns an ask into speech.
 */
export function networkResolverUnwiredNote(): ResolutionNote {
  return {
    code: 'network-resolver-unwired',
    severity: 'degraded',
    summary: 'Shell egress asks are never voiced: the sandbox bypasses the broker.',
    detail:
      'sandbox and resolveNetworkAccess are configured but getNetworkAccessResolver() ' +
      'was never called, so nothing the sandbox asks can reach the permission broker. ' +
      'Shell egress is settled by whatever the sandbox was wired to instead: never ' +
      'voiced to the talker, never recorded as an ask. WebFetch egress still routes ' +
      'through the broker, so the same question is spoken on one path and silent on ' +
      'the other.',
    remedy:
      "Wire getNetworkAccessResolver() into the SandboxProvider's network ask callback " +
      'to have shell egress voiced like WebFetch is. Ignore this if the sandbox is ' +
      'deliberately wired to your own permission UI.',
    data: { observedAt: 'first-prompt' },
  };
}

/**
 * A restore across a mode boundary (facade/cross-mode-restore.ts). Not an
 * assembly fact either: it is earned by restore(), so it is recorded then,
 * and replaced by the next restore.
 */
export function restoreModeMismatchNote(restore: ModeCrossingRestore): ResolutionNote {
  const data = {
    artifactMode: restore.artifactMode,
    agentMode: restore.agentMode,
    conversationLinesHandedOver: restore.conversationLinesHandedOver,
    talkerHistoryLength: restore.talkerHistoryLength,
    resultsNotRelayed: restore.resultsNotRelayed,
  };
  if (restore.artifactMode === 'duplex') {
    const handedOver = restore.conversationLinesHandedOver > 0
      ? `; the ${restore.conversationLinesHandedOver} most recent conversation lines, which the ` +
        'reasoner had not seen yet, were queued for it as context'
      : '';
    const unrelayed = restore.resultsNotRelayed > 0
      ? ` That includes ${restore.resultsNotRelayed} result(s) the talker had not yet relayed to the user.`
      : '';
    return {
      code: 'restore-mode-mismatch',
      severity: 'degraded',
      summary: "Restored a duplex session into a passthrough agent: the talker's side is carried but inactive.",
      detail:
        'The artifact was written by a duplex agent and this agent runs passthrough. Its single ' +
        "loop continues from the reasoner's history, which holds the conversation up to the last " +
        `delegation${handedOver}. The talker's history and memory, the task state and the ` +
        "talker's queued deliveries are carried unchanged through getState(), but nothing reads " +
        `them in passthrough.${unrelayed} They come back if the artifact is restored into a duplex agent.`,
      remedy: "Set mode: 'duplex' explicitly for sessions persisted from a duplex agent, so a change of backend cannot change the mode under a saved session.",
      data,
    };
  }
  const talkerStart = restore.talkerHistoryLength > 0
    ? 'starts from the history an earlier duplex run left it, which lacks the conversation since'
    : 'starts with no history';
  return {
    code: 'restore-mode-mismatch',
    severity: 'degraded',
    summary: 'Restored a passthrough session into a duplex agent: the talker starts without the recent conversation.',
    detail:
      'The artifact was written by a passthrough agent and this agent runs duplex. The reasoner ' +
      "continues from the single loop's history, which holds the whole conversation. The talker, " +
      `which speaks to the user, ${talkerStart}, so it knows the earlier conversation only through ` +
      'what the reasoner delivers.',
    remedy: "Set mode: 'passthrough' explicitly for sessions persisted from a passthrough agent, so a change of backend cannot change the mode under a saved session.",
    data,
  };
}
