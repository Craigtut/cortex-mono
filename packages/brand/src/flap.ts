/**
 * Split-flap primitives. NOT the animation, just the renderer-agnostic
 * constants and pure functions every split-flap surface reads from. The website
 * renders these in the DOM; the TUI renders its own terminal version from the
 * same numbers.
 */

/** Ordered set of characters a flap cell cycles through before it settles. */
export const flapAlphabet =
  ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:/<>_'.split('');

export const flapTiming = {
  /** Cold-start flip duration, ms. The motor spinning up. */
  startMs: 400,
  /** Top-speed flip duration, ms. The mid-riffle blur. */
  topMs: 150,
  /** Final settle flip duration, ms. Braking into the target. */
  endMs: 300,
  /** Flaps spent accelerating from startMs to topMs. */
  accelFlips: 5,
  /** Flaps spent braking from topMs to endMs. */
  decelFlips: 4,
  /** Rest once settled before a cell may move again, ms. */
  holdMs: 1300,
  /** Per-cell delay so a grid settles as a wave, ms. */
  cellStaggerMs: 22,
} as const;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Forward, wrapping distance from one character to another, in flaps. */
export function flapDistance(from: string, to: string): number {
  const a = flapAlphabet.indexOf(from);
  const b = flapAlphabet.indexOf(to);
  if (a === -1 || b === -1) return 0;
  return (b - a + flapAlphabet.length) % flapAlphabet.length;
}

/**
 * Per-flip durations for a journey of `steps` flaps: a trapezoidal motion
 * profile that spins up from startMs, cruises at topMs, and brakes to endMs.
 * For short journeys the accel and decel ramps overlap, so it never reaches top
 * speed, a couple of slow deliberate flips, which is exactly right.
 */
export function flipSchedule(steps: number): number[] {
  const { startMs, topMs, endMs, accelFlips, decelFlips } = flapTiming;
  const out: number[] = [];
  for (let k = 0; k < steps; k++) {
    const up = lerp(startMs, topMs, easeInOut(Math.min(1, k / accelFlips)));
    const down = lerp(
      endMs,
      topMs,
      easeInOut(Math.min(1, (steps - 1 - k) / decelFlips)),
    );
    out.push(Math.round(Math.max(up, down)));
  }
  return out;
}
