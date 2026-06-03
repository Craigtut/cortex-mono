import type { Scene } from '@animus-labs/brand';

/**
 * Hero scenes: a status board for the thinking machine. CORTEX holds steady as
 * the anchor (those cells never flip) while the state line cycles through the
 * machine's mechanism vocabulary and the descriptor rotates underneath.
 */
export const HERO_SCENES: Scene[] = [
  {
    hold: 3500,
    placements: [
      { text: 'CORTEX', row: 1, align: 'center' },
      { text: 'OBSERVING', row: 3, align: 'center' },
      { text: 'AGENT HARNESS', row: 5, align: 'center' },
    ],
  },
  {
    hold: 3500,
    placements: [
      { text: 'CORTEX', row: 1, align: 'center' },
      { text: 'REFLECTING', row: 3, align: 'center' },
      { text: 'THE THINKING MACHINE', row: 5, align: 'center' },
    ],
  },
  {
    hold: 3500,
    placements: [
      { text: 'CORTEX', row: 1, align: 'center' },
      { text: 'COMPACTING', row: 3, align: 'center' },
      { text: 'MECHANICAL COGNITION', row: 5, align: 'center' },
    ],
  },
  {
    hold: 3500,
    placements: [
      { text: 'CORTEX', row: 1, align: 'center' },
      { text: 'RESOLVING', row: 3, align: 'center' },
      { text: 'THE THINKING MACHINE', row: 5, align: 'center' },
    ],
  },
  {
    hold: 3500,
    placements: [
      { text: 'CORTEX', row: 1, align: 'center' },
      { text: 'READY', row: 3, align: 'center' },
      { text: 'AGENT HARNESS', row: 5, align: 'center' },
    ],
  },
];
