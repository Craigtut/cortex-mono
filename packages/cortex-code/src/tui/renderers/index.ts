/**
 * Per-tool renderer system barrel exports.
 */

// Types
export type {
  ToolStatus,
  ToolRenderContext,
  ToolCallDisplay,
  ToolResultDisplay,
  ToolRenderer,
} from './types.js';

// Theme
export { getToolTheme } from '../theme.js';
export type { ToolTheme } from '../theme.js';

// Components
export { BorderedBox } from './bordered-box.js';
export { ToolExecutionComponent } from './tool-execution.js';

// Utilities
export { collapseContent } from './collapsible-content.js';
export type { CollapseMode, CollapseOptions, CollapseResult } from './collapsible-content.js';
export { StreamingBuffer } from './streaming-buffer.js';
export { shortenPath, truncatePath, formatDuration } from './path-utils.js';
export { fileLink } from './osc-links.js';

// Registry
export { registerRenderer, getRenderer, hasRenderer } from './registry.js';

// Syntax highlighting
export { highlightCode, highlightFile, detectLanguage } from './syntax-highlighter.js';

// Renderers (importing registers them with the registry)
export { genericRenderer } from './generic-renderer.js';
export { readRenderer } from './read-renderer.js';
export { editRenderer } from './edit-renderer.js';
export { writeRenderer } from './write-renderer.js';
export { bashRenderer } from './bash-renderer.js';
