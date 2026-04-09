/**
 * OSC 8 terminal hyperlink utility.
 *
 * Wraps text in OSC 8 escape sequences to make it clickable in supported
 * terminals (iTerm2, WezTerm, Kitty, etc.). Unsupported terminals silently
 * ignore the sequences.
 */

import { pathToFileURL } from 'node:url';

/**
 * Wrap a file path in an OSC 8 hyperlink.
 *
 * @param path - Absolute file path
 * @param displayText - Text to display (defaults to the path itself)
 * @returns ANSI string with OSC 8 hyperlink wrapping
 */
export function fileLink(path: string, displayText?: string): string {
  const display = displayText ?? path;
  const uri = pathToFileURL(path).href;
  return `\x1b]8;;${uri}\x07${display}\x1b]8;;\x07`;
}
