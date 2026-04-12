/**
 * ToolSearch tool: load full tool schemas on demand.
 *
 * Auto-registered when `deferredTools.enabled` is true. The model uses this
 * tool to discover and load tools that appear by name in the
 * `_available_tools` slot but whose schemas are not yet in the agent's
 * tools array.
 *
 * Once a tool is loaded, it persists in the agent's tools array for the
 * rest of the session and can be called normally.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { CortexTool } from '../../tool-contract.js';
import type { ToolContentDetails } from '../../types.js';
import type { DeferredToolRegistry, ToolSearchResult } from './registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';

const DEFAULT_MAX_RESULTS = 5;
const QUERY_DESCRIPTION = [
  'Query for the tool(s) you want to load. Supported formats:',
  '- "select:NameA,NameB" to load specific tools by exact name (preferred when you already know the names from the available-tools list)',
  '- "exact_tool_name" to load a single tool by its exact name',
  '- "prefix" to load all tools starting with the given prefix (e.g., "mcp__obsidian")',
  '- "keyword another keyword" for keyword search across tool names and descriptions',
  '- prefix any keyword with "+" to require it (e.g., "+slack send")',
].join('\n');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ToolSearchParams = Type.Object({
  query: Type.String({ description: QUERY_DESCRIPTION }),
  max_results: Type.Optional(
    Type.Number({
      description: `Maximum number of tools to load when using keyword/prefix search. Default ${DEFAULT_MAX_RESULTS}. Ignored for select: queries (which always load every requested tool).`,
      default: DEFAULT_MAX_RESULTS,
    }),
  ),
});

export type ToolSearchParamsType = Static<typeof ToolSearchParams>;

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export interface ToolSearchDetails {
  query: string;
  loaded: string[];
  alreadyAvailable: string[];
  notFound: string[];
  totalDeferred: number;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface ToolSearchToolConfig {
  /** The deferred tool registry shared with CortexAgent. */
  registry: DeferredToolRegistry;
  /**
   * Called after the registry is updated. The agent uses this to refresh
   * its tools array (so the newly discovered tools appear in the next API
   * call) and update the `_available_tools` slot.
   */
  onAfterDiscovery: () => void;
}

export function createToolSearchTool(
  config: ToolSearchToolConfig,
): CortexTool<ToolSearchParamsType, ToolContentDetails<ToolSearchDetails>> {
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    description: [
      'Load tool schemas on demand. Some tools are not loaded by default to save context tokens; their names appear in the "Available Tools" section but their parameters are not visible to you yet.',
      '',
      'Call this tool to load specific tools before using them. Once loaded, tools become callable on the next turn.',
      '',
      'Use a "select:Name1,Name2" query when you already know the tool names you need (most common). Use keyword queries when you need to discover tools by capability.',
    ].join('\n'),
    parameters: ToolSearchParams,
    alwaysLoad: true, // ToolSearch itself must never be deferred
    async execute(params): Promise<ToolContentDetails<ToolSearchDetails>> {
      const max = params.max_results ?? DEFAULT_MAX_RESULTS;
      const result = config.registry.resolveQuery(params.query, max);

      const alreadyAvailable = result.resolved
        .map((t) => t.name)
        .filter((n) => !result.newlyDiscovered.includes(n));

      const totalDeferred = config.registry.getUndiscoveredNames().length;

      // Only trigger downstream refresh when something actually changed.
      if (result.newlyDiscovered.length > 0) {
        config.onAfterDiscovery();
      }

      const text = formatResultText(params.query, result, alreadyAvailable, totalDeferred);

      return {
        content: [{ type: 'text', text }],
        details: {
          query: params.query,
          loaded: result.newlyDiscovered,
          alreadyAvailable,
          notFound: result.notFound,
          totalDeferred,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatResultText(
  query: string,
  result: ToolSearchResult,
  alreadyAvailable: string[],
  totalDeferredAfter: number,
): string {
  const lines: string[] = [];

  if (result.newlyDiscovered.length > 0) {
    lines.push('Loaded the following tools (callable on the next turn):');
    for (const name of result.newlyDiscovered) {
      lines.push(`- ${name}`);
    }
  }

  if (alreadyAvailable.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Already loaded (no action needed):');
    for (const name of alreadyAvailable) {
      lines.push(`- ${name}`);
    }
  }

  if (result.notFound.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Not found in the deferred tool list:');
    for (const name of result.notFound) {
      lines.push(`- ${name}`);
    }
  }

  if (result.resolved.length === 0 && result.notFound.length === 0) {
    lines.push(`No tools matched the query: "${query}"`);
    if (totalDeferredAfter > 0) {
      lines.push('');
      lines.push(`There are ${totalDeferredAfter} tools still available. Refer to the "Available Tools" section for the full list.`);
    }
  }

  return lines.join('\n');
}
