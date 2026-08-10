/**
 * Working tags parser.
 *
 * Separates agent text into user-facing and working (internal reasoning)
 * content based on <working> XML tag delimiters.
 *
 * Parsing rules:
 * - Tags are flat delimiters: <working> opens, </working> closes. No nesting.
 * - Multiple <working> blocks are concatenated (newline-separated) in `working`.
 * - Whitespace between closing </working> tag and subsequent text is normalized.
 * - Unclosed <working> tag: all content after the opening tag is treated as working.
 * - Simple regex, not a full XML parser.
 *
 * Reference: working-tags.md
 */

import type { AgentTextOutput } from './types.js';

/**
 * Regex pattern for matching working tag blocks.
 *
 * Matches <working>...</working> pairs (non-greedy) and captures the content.
 * The `s` flag makes `.` match newlines so working content can span multiple lines.
 * The `g` flag finds all blocks in the text.
 */
const WORKING_TAG_PATTERN = /<working>(.*?)<\/working>/gs;

/**
 * Pattern for detecting an unclosed <working> tag at the end of the text.
 * Captures everything after the last unclosed <working> tag.
 */
const UNCLOSED_TAG_PATTERN = /<working>([\s\S]*)$/;

/**
 * Strip all <working> tag content from text, returning only user-facing content.
 * Whitespace is normalized: consecutive whitespace collapsed, trimmed.
 *
 * @param text - Raw agent text potentially containing <working> tags
 * @returns User-facing text with all working content removed
 */
export function stripWorkingTags(text: string): string {
  // Replace closed <working>...</working> blocks with a newline sentinel.
  // This ensures a clean break between content that was separated by a working block.
  // The sentinel is used instead of directly removing to enable whitespace normalization.
  let result = text.replace(WORKING_TAG_PATTERN, '\n');

  // Handle any unclosed <working> tag at the end
  result = result.replace(UNCLOSED_TAG_PATTERN, '');

  // Normalize whitespace:
  // 1. Collapse spaces/tabs around newlines into just the newline
  // 2. Collapse 3+ newlines to 2 (preserve paragraph breaks)
  result = result
    .replace(/[ \t]*\n[ \t]*/g, '\n')  // normalize spaces around newlines
    .replace(/\n{3,}/g, '\n\n')         // collapse 3+ newlines to 2
    .trim();

  return result;
}

/**
 * Extract content from inside <working> tags.
 * Multiple blocks are concatenated with newline separators.
 * Returns null if no working tags are found.
 *
 * @param text - Raw agent text potentially containing <working> tags
 * @returns Concatenated working content, or null if none found
 */
export function extractWorkingContent(text: string): string | null {
  const blocks: string[] = [];

  // Reset regex lastIndex since we reuse the global pattern
  WORKING_TAG_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = WORKING_TAG_PATTERN.exec(text)) !== null) {
    const content = match[1];
    if (content !== undefined && content.trim().length > 0) {
      blocks.push(content.trim());
    }
  }

  // Check for unclosed tag
  // We need to check if there's an unclosed <working> AFTER the last closed block
  const lastClosingIndex = text.lastIndexOf('</working>');
  const lastOpeningIndex = text.lastIndexOf('<working>');

  if (lastOpeningIndex > lastClosingIndex) {
    // There is an unclosed tag after all closed blocks
    const unclosedContent = text.slice(lastOpeningIndex + '<working>'.length);
    if (unclosedContent.trim().length > 0) {
      blocks.push(unclosedContent.trim());
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return blocks.join('\n');
}

/**
 * Parse text into structured AgentTextOutput with user-facing and working segments.
 *
 * This is the primary parsing function used by AgentLoop at turn completion.
 * It combines stripWorkingTags and extractWorkingContent into a single result.
 *
 * @param text - Raw agent text potentially containing <working> tags
 * @returns Structured output with userFacing, working, and raw properties
 */
export function parseWorkingTags(text: string): AgentTextOutput {
  return {
    userFacing: stripWorkingTags(text),
    working: extractWorkingContent(text),
    raw: text,
  };
}

// ---------------------------------------------------------------------------
// Streaming filter (voice-safe deltas)
// ---------------------------------------------------------------------------

const OPEN_TAG = '<working>';
const CLOSE_TAG = '</working>';

/**
 * Streaming working-tag filter with holdback buffering, for the duplex
 * facade's sanitized talker-delta stream (review-findings F6): raw
 * `response_chunk` deltas carry `<working>` content that TTS would speak
 * aloud, and tags split across chunks at arbitrary positions, so consumers
 * cannot strip them chunk-by-chunk themselves.
 *
 * Contract per assistant message (reset between messages):
 * - `push(chunk)` returns the text safe to emit now. Text from any `<` is
 *   HELD until disambiguated: released verbatim once it provably is not a
 *   working tag, swallowed if it opens one.
 * - Inside a working block, content is suppressed until `</working>`
 *   closes it (a completed block emits one newline, matching
 *   stripWorkingTags' sentinel so words on either side never jam together).
 * - `flush()` at stream end releases a held prefix that never became a tag
 *   (a trailing `<` IS emitted) and drops unterminated working content
 *   (matching stripWorkingTags' unclosed-tag rule). flush() is synchronous
 *   and unconditional: there is nothing to deadlock on when a close tag
 *   never arrives, because nothing ever waits; text is merely held until
 *   the next push or the flush.
 *
 * Whitespace differs slightly from the batch stripWorkingTags (which
 * normalizes and trims whole messages); the invariants that matter for
 * voice hold exactly: no working content is ever emitted, and all
 * user-facing content is emitted by flush() time.
 */
export class WorkingTagStreamFilter {
  private mode: 'text' | 'working' = 'text';
  /**
   * Held text. In text mode: an ambiguous prefix of `<working>` starting at
   * its `<`. In working mode: an ambiguous prefix of `</working>` (kept
   * only for matching; never emitted unless the close completes... it never
   * is: close-tag prefixes are suppressed content if they diverge).
   */
  private hold = '';

  /** Filter one raw delta; returns the text safe to emit now. */
  push(chunk: string): string {
    const input = this.hold + chunk;
    this.hold = '';
    let out = '';
    let i = 0;
    while (i < input.length) {
      if (this.mode === 'text') {
        const lt = input.indexOf('<', i);
        if (lt === -1) {
          out += input.slice(i);
          break;
        }
        out += input.slice(i, lt);
        const rest = input.slice(lt);
        if (rest.startsWith(OPEN_TAG)) {
          this.mode = 'working';
          i = lt + OPEN_TAG.length;
          continue;
        }
        if (OPEN_TAG.startsWith(rest)) {
          // Ambiguous prefix at chunk end: hold until the next push or
          // flush decides.
          this.hold = rest;
          break;
        }
        // Provably not the open tag: the '<' is literal text.
        out += '<';
        i = lt + 1;
      } else {
        const lt = input.indexOf('<', i);
        if (lt === -1) break; // all suppressed
        const rest = input.slice(lt);
        if (rest.startsWith(CLOSE_TAG)) {
          this.mode = 'text';
          // The completed block collapses to one newline, matching
          // stripWorkingTags' sentinel, so surrounding words stay separated.
          out += '\n';
          i = lt + CLOSE_TAG.length;
          continue;
        }
        if (CLOSE_TAG.startsWith(rest)) {
          this.hold = rest;
          break;
        }
        i = lt + 1; // a literal '<' inside working content: suppressed
      }
    }
    return out;
  }

  /**
   * End of stream: release a held text-mode prefix that never became a tag
   * (working-mode holds are suppressed content and are dropped, exactly as
   * stripWorkingTags drops an unclosed block).
   */
  flush(): string {
    const held = this.mode === 'text' ? this.hold : '';
    this.hold = '';
    return held;
  }

  /** Reset for the next assistant message. */
  reset(): void {
    this.mode = 'text';
    this.hold = '';
  }
}
