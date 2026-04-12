/**
 * DeferredToolRegistry: tracks the deferred tool pool and which tools the
 * agent has discovered (loaded) during this session.
 *
 * Lives on the CortexAgent instance. `refreshTools()` populates the deferred
 * pool from the union of registered + MCP tools (filtered by deferral
 * criteria), and `ToolSearch` updates the discovered set when the agent
 * resolves a query.
 *
 * The slot content (`formatSlotContent`) is the canonical text that goes
 * into the `_available_tools` slot. It is byte-stable for any given pool +
 * discovered set so the prompt cache hits cleanly.
 */

import type { CortexTool } from '../../tool-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of resolving a ToolSearch query.
 */
export interface ToolSearchResult {
  /** Tools that were resolved by the query (newly loaded + already loaded). */
  resolved: CortexTool[];
  /** Names of tools newly added to the discovered set by this query. */
  newlyDiscovered: string[];
  /** Names of tools the query referenced that were not found in the pool. */
  notFound: string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class DeferredToolRegistry {
  /** Tools currently eligible for deferral, keyed by name. */
  private deferredPool = new Map<string, CortexTool>();
  /** Names the model has loaded via ToolSearch. Persists for the session. */
  private discovered = new Set<string>();

  /**
   * Replace the deferred pool. Called by `refreshTools()` whenever the
   * underlying tool set changes (MCP server connect/disconnect, etc).
   *
   * Tools that were previously discovered remain in the discovered set even
   * if they're temporarily missing from the pool (e.g., MCP server briefly
   * disconnected). The next `refreshTools()` call will see them again.
   */
  setDeferredPool(tools: readonly CortexTool[]): void {
    this.deferredPool.clear();
    for (const tool of tools) {
      this.deferredPool.set(tool.name, tool);
    }
  }

  /**
   * Mark tool names as discovered. Subsequent `refreshTools()` calls will
   * include their full schemas in the agent's tools array.
   *
   * Returns the subset that were newly added (i.e., were not already
   * discovered). Used by ToolSearch to report what changed.
   */
  markDiscovered(names: readonly string[]): string[] {
    const added: string[] = [];
    for (const name of names) {
      if (!this.discovered.has(name)) {
        this.discovered.add(name);
        added.push(name);
      }
    }
    return added;
  }

  /**
   * The set of tool names the agent has loaded so far.
   */
  getDiscovered(): ReadonlySet<string> {
    return this.discovered;
  }

  /**
   * Names currently in the deferred pool that have NOT yet been discovered.
   * These are the names that should appear in the `_available_tools` slot.
   * Returned sorted alphabetically for deterministic, cache-stable output.
   */
  getUndiscoveredNames(): string[] {
    const names: string[] = [];
    for (const name of this.deferredPool.keys()) {
      if (!this.discovered.has(name)) {
        names.push(name);
      }
    }
    return names.sort();
  }

  /**
   * Format the `_available_tools` slot content. Names only (no descriptions),
   * sorted, in a fixed format. Returns an empty string when there are no
   * undiscovered tools (the slot will be set to empty content, which still
   * occupies a slot index but contributes no tokens).
   */
  formatSlotContent(): string {
    const names = this.getUndiscoveredNames();
    if (names.length === 0) {
      return '';
    }
    const list = names.map((n) => `- ${n}`).join('\n');
    return [
      '# Available Tools',
      '',
      'The following tools are available but their schemas have not been loaded.',
      'Use the ToolSearch tool to load a tool before calling it.',
      '',
      'Calling any of these tools directly (without loading first) will fail.',
      '',
      list,
    ].join('\n');
  }

  /**
   * Resolve a ToolSearch query against the deferred pool.
   *
   * Query formats:
   *   - "select:NameA,NameB"      Direct load by name. Bypasses scoring.
   *   - "ExactToolName"           Exact name match if it exists in the pool.
   *   - "prefix__"                Returns all tools starting with the prefix.
   *   - "keyword another"         Keyword search; scored by name + description.
   *
   * Discovered tools that are referenced by the query are still returned
   * (harmless no-op so the model gets confirmation), but they don't count
   * as "newly discovered".
   */
  resolveQuery(query: string, maxResults: number): ToolSearchResult {
    const trimmed = query.trim();

    // Direct select format
    if (trimmed.startsWith('select:')) {
      const requested = trimmed
        .slice('select:'.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return this.resolveByNames(requested);
    }

    // Empty or whitespace-only query: return nothing useful
    if (trimmed.length === 0) {
      return { resolved: [], newlyDiscovered: [], notFound: [] };
    }

    // Exact name match (single token, exists in pool)
    if (!/\s/.test(trimmed) && this.deferredPool.has(trimmed)) {
      return this.resolveByNames([trimmed]);
    }

    // Prefix match (single token, no spaces, ends with __ or matches a prefix)
    if (!/\s/.test(trimmed)) {
      const prefixMatches: string[] = [];
      for (const name of this.deferredPool.keys()) {
        if (name.startsWith(trimmed)) {
          prefixMatches.push(name);
        }
      }
      if (prefixMatches.length > 0) {
        prefixMatches.sort();
        return this.resolveByNames(prefixMatches.slice(0, maxResults));
      }
    }

    // Keyword search with scoring
    const scored = this.scoreKeywordQuery(trimmed);
    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .filter((entry) => entry.score > 0)
      .map((entry) => entry.name);

    if (top.length === 0) {
      return { resolved: [], newlyDiscovered: [], notFound: [] };
    }
    return this.resolveByNames(top);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private resolveByNames(names: readonly string[]): ToolSearchResult {
    const resolved: CortexTool[] = [];
    const notFound: string[] = [];
    const toMarkDiscovered: string[] = [];

    for (const name of names) {
      const tool = this.deferredPool.get(name);
      if (tool) {
        resolved.push(tool);
        toMarkDiscovered.push(name);
      } else {
        notFound.push(name);
      }
    }

    const newlyDiscovered = this.markDiscovered(toMarkDiscovered);
    return { resolved, newlyDiscovered, notFound };
  }

  private scoreKeywordQuery(query: string): Array<{ name: string; score: number }> {
    // Split into terms; "+term" means required.
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    const required = new Set<string>();
    const optional: string[] = [];
    for (const token of tokens) {
      if (token.startsWith('+') && token.length > 1) {
        required.add(token.slice(1));
      } else {
        optional.push(token);
      }
    }

    const allTerms = [...required, ...optional];
    if (allTerms.length === 0) return [];

    const results: Array<{ name: string; score: number }> = [];

    for (const [name, tool] of this.deferredPool.entries()) {
      const lowerName = name.toLowerCase();
      const lowerDesc = (tool.description ?? '').toLowerCase();
      // Tool name parts: split by __ (MCP namespacing) and underscore for general matching
      const nameParts = lowerName.split(/__|_/).filter((p) => p.length > 0);

      // Required terms must all match somewhere
      let satisfiesRequired = true;
      for (const req of required) {
        if (!lowerName.includes(req) && !lowerDesc.includes(req)) {
          satisfiesRequired = false;
          break;
        }
      }
      if (!satisfiesRequired) continue;

      const isMcp = tool.isMcp === true;
      let score = 0;
      for (const term of allTerms) {
        // Exact part match in name (highest weight)
        if (nameParts.includes(term)) {
          score += isMcp ? 12 : 10;
          continue;
        }
        // Partial part match
        if (nameParts.some((p) => p.includes(term))) {
          score += isMcp ? 6 : 5;
          continue;
        }
        // Full-name substring fallback
        if (lowerName.includes(term)) {
          score += 3;
          continue;
        }
        // Description substring
        if (lowerDesc.includes(term)) {
          score += 2;
        }
      }

      if (score > 0) {
        results.push({ name, score });
      }
    }

    return results;
  }
}
