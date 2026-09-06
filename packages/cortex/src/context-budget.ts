import { z } from 'zod';

/** Legacy export: fallback for unknown capacity, never a floor on explicit budgets. */
export const MINIMUM_CONTEXT_WINDOW = 16_384;

export interface ContextBudget {
  /** Backend capacity, independent of the loop's compaction policy. */
  capacity: number;
  /** Budget used by proactive compaction. */
  effective: number;
  adjustmentReason?: string;
}

const limitSchema = z.number().int().positive().nullable();

/** Shared policy for every provider. Resolving a budget never allocates backend memory. */
export function resolveContextBudget(modelCapacity: number, limit: number | null): ContextBudget {
  limitSchema.parse(limit);
  if (!Number.isFinite(modelCapacity) || modelCapacity <= 0) {
    return { capacity: MINIMUM_CONTEXT_WINDOW, effective: Math.min(limit ?? MINIMUM_CONTEXT_WINDOW, MINIMUM_CONTEXT_WINDOW),
      adjustmentReason: 'the model advertises no context window, so the safe floor applies instead' };
  }
  const effective = Math.min(modelCapacity, limit ?? modelCapacity);
  return {
    capacity: modelCapacity, effective,
    ...(limit === null || limit === effective ? {} : {
      adjustmentReason: "it exceeds the model's own context window",
    }),
  };
}
