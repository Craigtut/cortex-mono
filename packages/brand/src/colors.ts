/**
 * Cortex brand palette. See docs/brand-vision.md.
 * Pure data, no framework. The website and the TUI theme both read from here.
 */
export const colors = {
  /** Base and flaps. Warm green-black. Roughly 80% of every surface. */
  carbon: '#070906',
  /** Panel lift off carbon. */
  moss: '#13200F',
  /** Workhorse type. Warm cream. */
  bone: '#F2EBD6',
  /** Primary spark. Success, the lit cell, the cursor. About 5% of pixels. */
  acid: '#B8E23E',
  /** Secondary signal. Running, warning, secondary highlights. */
  amber: '#E5AC51',
  /** Flag. Errors only, almost never. */
  cinnabar: '#D8553F',
} as const;

export type ColorName = keyof typeof colors;
