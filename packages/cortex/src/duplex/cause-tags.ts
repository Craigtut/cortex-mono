/**
 * Discriminated cause tags (docs/cortex/duplex/decisions.md D16,
 * log-and-context.md causation).
 *
 * A cause tag rides delivered content into a loop (DeliverOptions.causeTag)
 * and surfaces on AgentLoop.activeRunCauseTags for exactly the run that
 * consumed it. The tag is SELF-DESCRIBING: it carries the causing log
 * entry's type alongside its seq, so a reader can tell a user utterance
 * from a delivery or a directive without resolving the seq against the
 * session log. Resolution would cost a log lookup per tag and, worse, the
 * log's retention policy can evict the entry, at which point a bare number
 * is unclassifiable forever. D16's consent check depends on the
 * discrimination: it asks whether a run's cause set INCLUDES a qualifying
 * user utterance, and once deliveries or directives share a run with
 * utterances (headline deliveries in 2b-ii land on the same talker port), a
 * set of bare seqs cannot answer that in either direction: collapsing then
 * filtering denies a real "yes" that a later non-utterance masked, and
 * collapsing without filtering grants consent off content the user never
 * spoke.
 *
 * The loop's tag slot stays `unknown` (the loop is a general-purpose
 * primitive); this module is the facade-side discipline over it.
 */

import { SESSION_LOG_ENTRY_TYPES } from '../session-log.js';
import type { SessionLogEntryType } from '../session-log.js';

/**
 * One discriminated cause: the causing log entry's type and seq. `kind` is
 * stamped by the facade at the site that appended the causing entry, never
 * derived by lookup.
 */
export interface CauseTag {
  readonly kind: SessionLogEntryType;
  readonly seq: number;
}

const ENTRY_TYPE_SET: ReadonlySet<string> = new Set(SESSION_LOG_ENTRY_TYPES);

/**
 * Structural check for a facade-stamped cause tag. The loop's tag slot is
 * `unknown`, so this is the only validator between arbitrary input and the
 * D16 consent decision: `kind` must be a real log entry type (the broker
 * branches on it) and `seq` a positive integer (log seqs start at 1; a NaN
 * here would poison latestCauseSeq and the causedBy stamp).
 */
export function isCauseTag(value: unknown): value is CauseTag {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const tag = value as { kind?: unknown; seq?: unknown };
  return typeof tag.kind === 'string' && ENTRY_TYPE_SET.has(tag.kind)
    && typeof tag.seq === 'number' && Number.isInteger(tag.seq) && tag.seq > 0;
}

/**
 * Collect the discriminated tags out of a loop's raw cause-tag set,
 * ignoring anything the facade did not stamp. Nested arrays are flattened:
 * a delivery carries ONE causeTag slot, so a delivery that itself carries a
 * whole run's causation (the truncation repair turn) rides as an array of
 * tags inside that slot.
 *
 * The returned set carries NO ordering guarantee. A reader deciding
 * anything from it (the D16 consent check above all) must scan the whole
 * set, never assume ascending seq order or read only the last element.
 */
export function collectCauseTags(tags: readonly unknown[]): CauseTag[] {
  const collected: CauseTag[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isCauseTag(value)) collected.push(value);
  };
  for (const tag of tags) visit(tag);
  return collected;
}

/**
 * Highest seq among the discriminated tags on a run, or null. This is the
 * LOG-STAMPING collapse (seqs are monotonic, so the highest tag is the most
 * recent cause when several ride one run, e.g. two barge-ins delivered by a
 * single sweep). It deliberately discards kind and the rest of the set;
 * never use it for consent decisions, which must read the full set
 * (decisions.md D16).
 */
export function latestCauseSeq(tags: readonly unknown[]): number | null {
  let latest: number | null = null;
  for (const tag of collectCauseTags(tags)) {
    if (latest === null || tag.seq > latest) {
      latest = tag.seq;
    }
  }
  return latest;
}
