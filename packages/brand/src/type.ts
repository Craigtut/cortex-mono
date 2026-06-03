/**
 * Type system. DM Mono carries mechanism (wordmark, readout, the board).
 * DM Sans carries prose.
 */
export const fonts = {
  mono: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "'DM Sans', ui-sans-serif, system-ui, sans-serif",
} as const;

/** Google Fonts stylesheet href for DM Sans + DM Mono. */
export const googleFontsHref =
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;700&display=swap';
