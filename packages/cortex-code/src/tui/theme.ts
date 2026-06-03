import { createRequire } from 'node:module';
import chalk from 'chalk';
import type { MarkdownTheme } from '@earendil-works/pi-tui';
import type { SelectListTheme } from '@earendil-works/pi-tui';
import { colors as brand } from '@animus-labs/brand';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
//
// The brand palette (carbon, moss, bone, acid, amber, cinnabar) governs brand
// surfaces: the logo and the banner. Inline emphasis and tool rendering need
// quieter, legible tones, so the acid spark is toned down for everyday use:
//
//   acid #B8E23E  ->  reserved for the banner and the spinner peak (rare)
//   accent #B5CD6F  ->  the workhorse highlight (headings, links, selection)
//   accentDeep #4A691F  ->  borders, rules, the dimmer end of the spinner
//
// The acid family is dark-first ("lime on warm carbon"). On a light terminal
// the bright tones wash out, so the light variant collapses toward the deep
// olive end, which is the only acid tone with contrast on a pale background.
// We do not own body-text color (the terminal does); we only set the accents
// we actively draw.

interface PaletteTokens {
  /** Brand acid. The banner letters and the spinner peak. Rare. */
  accentBright: string;
  /** Toned acid. The workhorse highlight: headings, links, bullets, selection. */
  accent: string;
  /** Mid acid. The middle of the spinner ramp. */
  accentMid: string;
  /** Deep acid/olive. Borders, rules, quote bars, the dim end of the spinner. */
  accentDeep: string;
  /** Secondary signal. Inline code, warnings, the running state. */
  amber: string;
  /** Error flag. */
  error: string;
  /** Added lines, resolved/healthy states. */
  success: string;
  muted: string;
  borderMuted: string;
  diffAdd: string;
  diffRemove: string;
  diffContext: string;
  lineNumber: string;
  statusPending: string;
  /** Panel lift (overlays, scrollable viewers). */
  panelBg: string;
  panelBgError: string;
  /** User-message background. A toned-down acid tint. */
  userBg: string;
  /** Default content color inside owned panels. */
  contentFg: string;
  /** Badge text color (sits on an acid/amber chip). */
  ink: string;
}

const darkTokens: PaletteTokens = {
  accentBright: brand.acid, // #B8E23E
  accent: '#B5CD6F',
  accentMid: '#81A52E',
  accentDeep: '#4A691F',
  amber: brand.amber, // #E5AC51
  error: brand.cinnabar, // #D8553F
  success: '#4ADE80',
  muted: '#6B7280',
  borderMuted: '#4B5563',
  diffAdd: '#4ADE80',
  diffRemove: brand.cinnabar,
  diffContext: '#6B7280',
  lineNumber: '#6B7280',
  statusPending: '#6B7280',
  panelBg: brand.moss, // #13200F
  panelBgError: '#2E1A1A',
  userBg: '#18220E',
  contentFg: '#D1D5DB',
  ink: brand.carbon, // #070906
};

const lightTokens: PaletteTokens = {
  // Bright/toned acid vanish on a pale background, so the light ramp lives in
  // the olive end where contrast holds.
  accentBright: '#4A691F',
  accent: '#4A691F',
  accentMid: '#5C7D26',
  accentDeep: '#4A691F',
  amber: '#B5790F',
  error: '#C2402B',
  success: '#16A34A',
  muted: '#6B7280',
  borderMuted: '#9CA3AF',
  diffAdd: '#16A34A',
  diffRemove: '#C2402B',
  diffContext: '#9CA3AF',
  lineNumber: '#9CA3AF',
  statusPending: '#6B7280',
  panelBg: '#F3F4F6',
  panelBgError: '#FEF2F2',
  userBg: '#ECEFE1',
  contentFg: '#374151',
  ink: brand.carbon,
};

/**
 * Auto-detect terminal background brightness.
 * Uses COLORFGBG env var (format: "fg;bg" where bg >= 8 is dark).
 * Falls back to dark theme. This is the only synchronous signal available;
 * many terminals never set it, so dark is the deliberate default.
 */
function detectDarkMode(): boolean {
  const colorfgbg = process.env['COLORFGBG'];
  if (colorfgbg) {
    const parts = colorfgbg.split(';');
    const bg = parseInt(parts[parts.length - 1] ?? '', 10);
    if (!isNaN(bg) && bg < 8) return false; // light background
  }
  return true; // default to dark
}

/** Resolved palette for the active terminal. Single source for all surfaces. */
export const palette: PaletteTokens = detectDarkMode() ? darkTokens : lightTokens;

// ---------------------------------------------------------------------------
// Tool renderer theme
// ---------------------------------------------------------------------------

export interface ToolTheme {
  // Brand
  primary: string;
  accent: string;
  error: string;
  success: string;
  muted: string;

  // Tool rendering
  border: string;
  borderMuted: string;
  diffAdd: string;
  diffRemove: string;
  diffContext: string;
  lineNumber: string;

  // Status indicators
  statusPending: string;
  statusSuccess: string;
  statusError: string;

  // Backgrounds (hex values for bgHex)
  bgDefault: string;
  bgError: string;
}

const activeToolTheme: ToolTheme = {
  primary: palette.accent,
  accent: palette.amber,
  error: palette.error,
  success: palette.success,
  muted: palette.muted,

  border: palette.accentDeep,
  borderMuted: palette.borderMuted,
  diffAdd: palette.diffAdd,
  diffRemove: palette.diffRemove,
  diffContext: palette.diffContext,
  lineNumber: palette.lineNumber,

  statusPending: palette.statusPending,
  statusSuccess: palette.success,
  statusError: palette.error,

  bgDefault: palette.panelBg,
  bgError: palette.panelBgError,
};

export function getToolTheme(): ToolTheme {
  return activeToolTheme;
}

// ---------------------------------------------------------------------------
// Brand colors (chalk helpers, resolved from the active palette)
// ---------------------------------------------------------------------------

export const colors = {
  primary: chalk.hex(palette.accent),
  primaryMuted: chalk.hex(palette.accentDeep),
  primaryBg: chalk.bgHex(palette.accentBright).hex(palette.ink),
  accent: chalk.hex(palette.amber),
  accentBg: chalk.bgHex(palette.amber).hex(palette.ink),
  error: chalk.hex(palette.error),
  success: chalk.hex(palette.success),
  muted: chalk.hex(palette.muted),
  dim: chalk.dim,
  bold: chalk.bold,
  // Emphasis without owning a hue: the terminal keeps control of text color.
  white: chalk.bold,
  userMessageBg: (s: string) => chalk.bgHex(palette.userBg)(s),
};

// Lazy-loaded syntax highlighter (cli-highlight wraps highlight.js)
let highlightFn: ((code: string, options?: { language?: string }) => string) | null = null;
let highlightLoaded = false;

function loadHighlighter(): typeof highlightFn {
  if (highlightLoaded) return highlightFn;
  highlightLoaded = true;
  try {
    const mod = require('cli-highlight') as { highlight: typeof highlightFn };
    highlightFn = mod.highlight;
  } catch {
    highlightFn = null;
  }
  return highlightFn;
}

export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.hex(palette.accent)(s),
  link: (s) => chalk.hex(palette.accent)(s),
  linkUrl: (s) => chalk.hex(palette.muted)(s),
  code: (s) => chalk.hex(palette.amber)(s),
  codeBlock: (s) => s,
  // pi-tui passes the raw ```lang fence text here for both the top and bottom
  // of a code block. Ignore it and draw a short rule instead of literal backticks.
  codeBlockBorder: () => chalk.hex(palette.accentDeep)('─────'),
  quote: (s) => chalk.italic.hex(palette.muted)(s),
  quoteBorder: (s) => chalk.hex(palette.accentDeep)(s),
  hr: (s) => chalk.hex(palette.accentDeep)(s),
  listBullet: (s) => chalk.hex(palette.accent)(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
  highlightCode: (code: string, lang?: string): string[] => {
    const highlight = loadHighlighter();
    if (!highlight) {
      return code.split('\n');
    }
    try {
      const opts: { language?: string } = {};
      if (lang) opts.language = lang;
      const highlighted = highlight(code, opts);
      return highlighted.split('\n');
    } catch {
      // Fallback: return unhighlighted lines
      return code.split('\n');
    }
  },
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => chalk.hex(palette.accent)(s),
  selectedText: (s) => chalk.hex(palette.accent)(s),
  description: (s) => chalk.hex(palette.muted)(s),
  scrollInfo: (s) => chalk.hex(palette.muted)(s),
  noMatch: (s) => chalk.hex(palette.muted)(s),
};

export const editorTheme = {
  borderColor: (s: string) => chalk.hex(palette.accentDeep)(s),
  selectList: selectListTheme,
};
