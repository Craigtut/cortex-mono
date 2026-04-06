import chalk from 'chalk';
import type { MarkdownTheme } from '@mariozechner/pi-tui';
import type { SelectListTheme } from '@mariozechner/pi-tui';

// Brand colors
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
