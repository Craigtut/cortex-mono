import chalk from 'chalk';
import type { MarkdownTheme } from '@mariozechner/pi-tui';
import type { SelectListTheme } from '@mariozechner/pi-tui';

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

const darkToolTheme: ToolTheme = {
  primary: '#00E5CC',
  accent: '#FFB347',
  error: '#FF6B6B',
  success: '#4ADE80',
  muted: '#6B7280',

  border: '#008577',
  borderMuted: '#4B5563',
  diffAdd: '#4ADE80',
  diffRemove: '#FF6B6B',
  diffContext: '#6B7280',
  lineNumber: '#6B7280',

  statusPending: '#6B7280',
  statusSuccess: '#4ADE80',
  statusError: '#FF6B6B',

  bgDefault: '#1a1a2e',
  bgError: '#2e1a1a',
};

const lightToolTheme: ToolTheme = {
  primary: '#007A6D',
  accent: '#D4850A',
  error: '#DC2626',
  success: '#16A34A',
  muted: '#6B7280',

  border: '#007A6D',
  borderMuted: '#9CA3AF',
  diffAdd: '#16A34A',
  diffRemove: '#DC2626',
  diffContext: '#9CA3AF',
  lineNumber: '#9CA3AF',

  statusPending: '#6B7280',
  statusSuccess: '#16A34A',
  statusError: '#DC2626',

  bgDefault: '#F3F4F6',
  bgError: '#FEF2F2',
};

/**
 * Auto-detect terminal background brightness.
 * Uses COLORFGBG env var (format: "fg;bg" where bg >= 8 is dark).
 * Falls back to dark theme.
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

let activeToolTheme: ToolTheme | null = null;

export function getToolTheme(): ToolTheme {
  if (!activeToolTheme) {
    activeToolTheme = detectDarkMode() ? darkToolTheme : lightToolTheme;
  }
  return activeToolTheme;
}

// Brand colors (existing, preserved for backward compatibility)
export const colors = {
  primary: chalk.hex('#00E5CC'),
  primaryMuted: chalk.hex('#008577'),
  primaryBg: chalk.bgHex('#00E5CC').hex('#000000'),
  accent: chalk.hex('#FFB347'),
  accentBg: chalk.bgHex('#FFB347').hex('#000000'),
  error: chalk.hex('#FF6B6B'),
  success: chalk.hex('#4ADE80'),
  muted: chalk.hex('#6B7280'),
  dim: chalk.dim,
  bold: chalk.bold,
  white: chalk.white,
  userMessageBg: (s: string) => chalk.bgHex('#0D2926')(s),
};

// Lazy-loaded syntax highlighter (cli-highlight wraps highlight.js)
let highlightFn: ((code: string, options?: { language?: string }) => string) | null = null;
let highlightLoaded = false;

function loadHighlighter(): typeof highlightFn {
  if (highlightLoaded) return highlightFn;
  highlightLoaded = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('cli-highlight') as { highlight: typeof highlightFn };
    highlightFn = mod.highlight;
  } catch {
    highlightFn = null;
  }
  return highlightFn;
}

export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.hex('#00E5CC')(s),
  link: (s) => chalk.hex('#00E5CC')(s),
  linkUrl: (s) => chalk.hex('#6B7280')(s),
  code: (s) => chalk.hex('#FFB347')(s),
  codeBlock: (s) => s,
  codeBlockBorder: (s) => chalk.hex('#008577')(s),
  quote: (s) => chalk.italic.hex('#6B7280')(s),
  quoteBorder: (s) => chalk.hex('#008577')(s),
  hr: (s) => chalk.hex('#008577')(s),
  listBullet: (s) => chalk.hex('#00E5CC')(s),
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
  selectedPrefix: (s) => chalk.hex('#00E5CC')(s),
  selectedText: (s) => chalk.hex('#00E5CC')(s),
  description: (s) => chalk.hex('#6B7280')(s),
  scrollInfo: (s) => chalk.hex('#6B7280')(s),
  noMatch: (s) => chalk.hex('#6B7280')(s),
};

export const editorTheme = {
  borderColor: (s: string) => chalk.hex('#008577')(s),
  selectList: selectListTheme,
};
