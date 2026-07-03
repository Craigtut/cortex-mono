/**
 * Terminal output sanitizer (security boundary).
 *
 * Tool results, file contents, and model-authored strings are rendered into a
 * live terminal. Any raw control byte in that text can hijack the display: an
 * ESC sequence can recolor or reposition the cursor to forge a permission
 * dialog, OSC 8 can inject a clickable link, OSC 52 can write the user's
 * clipboard, and CR can overwrite a previously drawn line. A prompt-injected
 * tool call is enough to smuggle these bytes in.
 *
 * This module strips every C0 control character (except the structural
 * whitespace \n and \t), DEL, and every C1 control character before the text
 * reaches a renderer. It mirrors the stripper in terminal/title-manager.ts,
 * which guards the OSC window-title sequence.
 *
 * Legitimate ANSI styling (chalk colors) is added by the renderers *after*
 * sanitization, so it is unaffected.
 */

/**
 * All C0 control characters except TAB (0x09) and LF (0x0a), plus DEL (0x7f)
 * and all C1 control characters (0x80-0x9f). This deliberately includes ESC
 * (0x1b), BEL (0x07), and CR (0x0d).
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'g');

/** Backstop cap so a pathological single blob cannot stall the renderer. */
const DEFAULT_MAX_TEXT = 50_000;
/** Tighter cap for single-line UI (dialog summaries, link labels). */
const DEFAULT_MAX_LINE = 2_000;

/**
 * Strip dangerous control characters from multi-line terminal text.
 *
 * Newlines and tabs are preserved so callers can still split into lines and
 * keep indentation; ESC/BEL/CR and every other control byte are removed. The
 * result is capped at `maxLength` characters as a rendering backstop.
 */
export function sanitizeTerminalText(raw: string, maxLength = DEFAULT_MAX_TEXT): string {
  if (!raw) return '';
  let s = raw.replace(CONTROL_CHARS, '');
  if (s.length > maxLength) {
    s = s.slice(0, maxLength);
  }
  return s;
}

/**
 * Strip control characters and flatten to a single line for compact UI such as
 * the permission dialog summary or an OSC 8 link label. Newlines and tabs are
 * collapsed to single spaces so the value cannot spill across rows.
 */
export function sanitizeTerminalLine(raw: string, maxLength = DEFAULT_MAX_LINE): string {
  if (!raw) return '';
  let s = raw.replace(CONTROL_CHARS, '');
  s = s.replace(/[\t\n]+/g, ' ');
  if (s.length > maxLength) {
    s = s.slice(0, maxLength);
  }
  return s;
}
