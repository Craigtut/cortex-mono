/**
 * Renderer registry: maps tool names to ToolRenderer implementations.
 *
 * Falls back to the generic renderer for unknown tools and MCP tools.
 * Built-in renderers are registered at import time.
 */

import type { ToolRenderer } from './types.js';
import { genericRenderer } from './generic-renderer.js';

const renderers = new Map<string, ToolRenderer>();

/**
 * Register a renderer for a tool name.
 */
export function registerRenderer(toolName: string, renderer: ToolRenderer): void {
  renderers.set(toolName, renderer);
}

/**
 * Get the renderer for a tool name.
 * Returns the generic renderer if no specific renderer is registered.
 */
export function getRenderer(toolName: string): ToolRenderer {
  return renderers.get(toolName) ?? genericRenderer;
}

/**
 * Check if a specific renderer is registered for a tool name.
 */
export function hasRenderer(toolName: string): boolean {
  return renderers.has(toolName);
}
