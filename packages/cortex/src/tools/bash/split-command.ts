/**
 * Quote-aware shell command splitter.
 *
 * Splits a shell command into its individual simple-commands: it splits on
 * unquoted `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines, and extracts the
 * bodies of command substitutions (`$(...)`, backticks), process
 * substitutions, and subshells as additional commands. The contents of quotes
 * are preserved on their owning command; redirections stay attached.
 *
 * This is intentionally a focused splitter, not a full bash parser. When it
 * cannot confidently parse something it fails safe: ambiguous input yields
 * segments that won't silently satisfy a narrow security check.
 *
 * Used by permission rule matching (cortex-code) and by the catastrophic
 * command floor (`catastrophic.ts`); keep the single implementation here.
 */

export interface SplitBashOptions {
  /**
   * Text inserted in the parent command where a command substitution
   * (`$(...)`, backticks) or process substitution was extracted. Defaults to
   * a single space. Security analyzers pass a sentinel here so an operand
   * whose value came from a substitution remains visible as "not statically
   * resolvable" instead of vanishing.
   */
  substitutionMarker?: string | undefined;
}

interface Balanced {
  body: string;
  end: number;
}

/**
 * Read a balanced `open`/`close` delimited region. `start` points at the first
 * character *after* the opening delimiter. Quote- and escape-aware so closing
 * delimiters inside strings don't end the region early. On unbalanced input,
 * consumes the rest of the string (fail safe).
 */
function readBalanced(s: string, start: number, open: string, close: string): Balanced {
  let depth = 1;
  let i = start;
  let quote: '"' | "'" | null = null;
  while (i < s.length) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === open) { depth++; i++; continue; }
    if (c === close) {
      depth--;
      if (depth === 0) return { body: s.slice(start, i), end: i };
      i++;
      continue;
    }
    i++;
  }
  return { body: s.slice(start), end: s.length - 1 };
}

/** Read a backtick-delimited region. `start` points just after the opening backtick. */
function readBacktick(s: string, start: number): Balanced {
  let i = start;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '`') return { body: s.slice(start, i), end: i };
    i++;
  }
  return { body: s.slice(start), end: s.length - 1 };
}

function scanInto(input: string, out: string[], marker: string): void {
  let current = '';
  const nested: string[] = [];
  let i = 0;
  const n = input.length;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    const t = current.trim();
    if (t) out.push(t);
    current = '';
  };

  while (i < n) {
    const c = input[i]!;

    // Backslash escape (literal next char) — not inside single quotes.
    if (c === '\\' && quote !== "'") {
      current += c;
      if (i + 1 < n) { current += input[i + 1]; i += 2; } else { i += 1; }
      continue;
    }

    if (quote === "'") {
      current += c;
      if (c === "'") quote = null;
      i++;
      continue;
    }

    if (quote === '"') {
      if (c === '"') { current += c; quote = null; i++; continue; }
      // Command substitution works inside double quotes too.
      if (c === '$' && input[i + 1] === '(') {
        if (input[i + 2] === '(') { // arithmetic $(( )) — not a command
          const r = readBalanced(input, i + 1, '(', ')');
          current += input.slice(i, r.end + 1);
          i = r.end + 1;
          continue;
        }
        const r = readBalanced(input, i + 2, '(', ')');
        nested.push(r.body);
        current += marker;
        i = r.end + 1;
        continue;
      }
      if (c === '`') {
        const r = readBacktick(input, i + 1);
        nested.push(r.body);
        current += marker;
        i = r.end + 1;
        continue;
      }
      current += c;
      i++;
      continue;
    }

    // Not currently inside quotes.
    if (c === "'" || c === '"') { quote = c; current += c; i++; continue; }

    // Command substitution / arithmetic.
    if (c === '$' && input[i + 1] === '(') {
      if (input[i + 2] === '(') {
        const r = readBalanced(input, i + 1, '(', ')');
        current += input.slice(i, r.end + 1);
        i = r.end + 1;
        continue;
      }
      const r = readBalanced(input, i + 2, '(', ')');
      nested.push(r.body);
      current += marker;
      i = r.end + 1;
      continue;
    }
    if (c === '`') {
      const r = readBacktick(input, i + 1);
      nested.push(r.body);
      current += marker;
      i = r.end + 1;
      continue;
    }
    // Process substitution <( ) >( ).
    if ((c === '<' || c === '>') && input[i + 1] === '(') {
      const r = readBalanced(input, i + 2, '(', ')');
      nested.push(r.body);
      current += marker;
      i = r.end + 1;
      continue;
    }
    // Subshell at command position.
    if (c === '(' && current.trim() === '') {
      const r = readBalanced(input, i + 1, '(', ')');
      nested.push(r.body);
      i = r.end + 1;
      continue;
    }

    // Redirections: keep operator and any &fd attached so the `&` in `2>&1`
    // and `&>` is not mistaken for a background/control operator below.
    if (c === '>' || c === '<') {
      current += c;
      i++;
      if (c === '>' && input[i] === '>') { current += '>'; i++; }
      if (input[i] === '&') {
        current += '&';
        i++;
        if (input[i] !== undefined && /\d/.test(input[i]!)) { current += input[i]; i++; }
      }
      continue;
    }

    // Control operators that separate commands.
    if (c === '&') {
      if (input[i + 1] === '>') { // &> or &>> redirect, not background
        current += '&>';
        i += 2;
        if (input[i] === '>') { current += '>'; i++; }
        continue;
      }
      flush();
      i += input[i + 1] === '&' ? 2 : 1; // && or single &
      continue;
    }
    if (c === '|') {
      flush();
      i += (input[i + 1] === '|' || input[i + 1] === '&') ? 2 : 1; // || or |& or |
      continue;
    }
    if (c === ';') { flush(); i++; continue; }
    if (c === '\n') { flush(); i++; continue; }

    current += c;
    i++;
  }
  flush();

  for (const body of nested) scanInto(body, out, marker);
}

/**
 * Split a shell command into its individual simple-commands.
 *
 * Always returns at least one element (the trimmed input) so callers can rely
 * on a non-empty result.
 */
export function splitBashCommand(command: string, options?: SplitBashOptions): string[] {
  const out: string[] = [];
  scanInto(command, out, options?.substitutionMarker ?? ' ');
  if (out.length > 0) return out;
  const trimmed = command.trim();
  return trimmed ? [trimmed] : [];
}

/** True if the command contains more than one simple-command. */
export function isCompoundBash(command: string): boolean {
  return splitBashCommand(command).length > 1;
}
