import { colors } from './colors.js';
import { fonts } from './type.js';

/**
 * Brand tokens as a CSS custom-property block. Single source of truth for the
 * website's colors and faces. Inject once in the document head so the values
 * are baked into the prerendered HTML.
 */
export function themeCss(): string {
  return [
    ':root{',
    `--color-carbon:${colors.carbon};`,
    `--color-moss:${colors.moss};`,
    `--color-bone:${colors.bone};`,
    `--color-acid:${colors.acid};`,
    `--color-amber:${colors.amber};`,
    `--color-cinnabar:${colors.cinnabar};`,
    `--font-mono:${fonts.mono};`,
    `--font-sans:${fonts.sans};`,
    '}',
  ].join('');
}
