/**
 * Recall tool: search through past conversation history.
 *
 * The consumer provides a search function via RecallConfig. This module
 * wraps it into a CortexTool that the agent can invoke to retrieve
 * specific details from persisted messages. Observations include
 * timestamps, enabling temporal anchoring for precise recall queries.
 *
 * Reference: docs/cortex/observational-memory-architecture.md (Recall Tool)
 */

import { Type } from '@sinclair/typebox';
import type { CortexTool } from '../../tool-contract.js';
import type { RecallConfig, RecallResult } from './types.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RecallParams = Type.Object({
  query: Type.String({
    description: 'What to search for in past conversation history',
  }),
  timeRange: Type.Optional(
    Type.Object(
      {
        start: Type.Optional(
          Type.String({ description: 'ISO date string for range start' }),
        ),
        end: Type.Optional(
          Type.String({ description: 'ISO date string for range end' }),
        ),
      },
      {
        description:
          'Optional time range to narrow results. Use timestamps from your observations.',
      },
    ),
  ),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of results to include in the formatted output. */
const MAX_RESULTS = 10;

/** Maximum character length per individual result content. */
const MAX_RESULT_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatResult(result: RecallResult): string {
  const role = result.role ?? result.type;
  const timestamp = result.timestamp.toISOString();
  const content =
    result.content.length > MAX_RESULT_CHARS
      ? result.content.slice(0, MAX_RESULT_CHARS) + '... (truncated)'
      : result.content;

  return `[${role}] (${timestamp}): ${content}`;
}

function formatResults(results: RecallResult[]): string {
  if (results.length === 0) {
    return 'No results found for your query.';
  }

  const limited = results.slice(0, MAX_RESULTS);
  const lines = limited.map(formatResult);

  if (results.length > MAX_RESULTS) {
    lines.push(
      `\n(${results.length - MAX_RESULTS} additional results omitted)`,
    );
  }

  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create a CortexTool that wraps the consumer's recall search function.
 *
 * The returned tool lets the agent search through persisted conversation
 * history using a free-text query and optional time range derived from
 * observation timestamps.
 */
export function createRecallTool(recallConfig: RecallConfig): CortexTool<{
  query: string;
  timeRange?: { start?: string; end?: string };
}, string> {
  return {
    name: 'recall',
    description:
      'Search through past conversation history for specific details. ' +
      'Use when your observations mention something but lack the detail needed, ' +
      'or when you need exact content (code, errors, quotes, URLs). ' +
      'Include a timeRange from your observation timestamps for precision.',
    parameters: RecallParams,

    async execute(params): Promise<string> {
      const { query, timeRange } = params;

      // Build the time range object without assigning undefined to optional
      // properties (exactOptionalPropertyTypes is enabled).
      let options: { timeRange?: { start?: Date; end?: Date } } | undefined;
      if (timeRange) {
        const range: { start?: Date; end?: Date } = {};
        if (timeRange.start) {
          range.start = new Date(timeRange.start);
        }
        if (timeRange.end) {
          range.end = new Date(timeRange.end);
        }
        options = { timeRange: range };
      }

      const results = await recallConfig.search(query, options);

      return formatResults(results);
    },
  };
}
