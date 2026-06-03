/**
 * Thinking words. The whimsy fillers are grabbed from Cortex Code's spinner so
 * the website and the TUI speak the same dialect; Cortex Code can later import
 * these from here to dedupe. See docs/brand-vision.md (Voice).
 */

/** Honest states, shown when a real mechanism is active. */
export const honestStates = ['observing', 'reflecting', 'compacting', 'resolving'] as const;

/** Whimsy fillers, cycled while the model is just thinking. Deadpan, alive. */
export const thinkingWords = [
  'Thinking', 'Musing', 'Brewing', 'Doodling',
  'Bubbling', 'Rummaging', 'Woolgathering', 'Waffling',
  'Larking', 'Slurping', 'Fizzing', 'Dawdling',
  'Whittling', 'Burbling', 'Gallivanting', 'Unfurling',
  'Steeping', 'Fermenting', 'Sauntering', 'Oscillating',
  'Kindling', 'Humming', 'Sifting', 'Weaving',
  'Ambling', 'Roving', 'Stirring', 'Gleaning',
  'Idling', 'Lilting',
] as const;

/** House signature. The machine consults its own brain. */
export const thinkingSignature = 'consulting the cortex';
