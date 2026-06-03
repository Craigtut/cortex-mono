import { describe, it, expect } from 'vitest';
import {
  colors,
  flapAlphabet,
  flapTiming,
  flipSchedule,
  flapDistance,
  composite,
  honestStates,
  thinkingWords,
  themeCss,
} from '../src/index.js';

describe('brand tokens', () => {
  it('exposes the locked palette as six-digit hex', () => {
    for (const hex of Object.values(colors)) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(colors.carbon).toBe('#070906');
    expect(colors.acid).toBe('#B8E23E');
    expect(colors.cinnabar).toBe('#D8553F');
  });

  it('renders a css variable for every color', () => {
    const css = themeCss();
    for (const name of Object.keys(colors)) {
      expect(css).toContain(`--color-${name}:`);
    }
  });

  it('carries split-flap primitives and thinking words', () => {
    expect(flapAlphabet.length).toBeGreaterThan(0);
    expect(flapTiming.topMs).toBeGreaterThan(0);
    expect(honestStates).toContain('observing');
    expect(thinkingWords.length).toBe(30);
  });

  it('builds a motion profile that spins up and brakes', () => {
    const s = flipSchedule(20);
    expect(s).toHaveLength(20);
    const mid = s[Math.floor(s.length / 2)]!;
    expect(s[0]!).toBeGreaterThan(mid); // cold start is slower than the cruise
    expect(s[s.length - 1]!).toBeGreaterThan(mid); // brakes into the target
    expect(Math.min(...s)).toBeGreaterThanOrEqual(flapTiming.topMs - 1);
  });

  it('measures forward, wrapping distance', () => {
    expect(flapDistance('A', 'B')).toBe(1);
    expect(flapDistance('A', 'A')).toBe(0);
    expect(flapDistance('B', 'A')).toBe(flapAlphabet.length - 1);
  });

  it('composites placements into a character grid', () => {
    expect(composite([{ text: 'HI', row: 0, align: 'left' }], 1, 4).join('')).toBe('HI  ');
    expect(composite([{ text: 'AB', row: 0, align: 'center' }], 1, 4).join('')).toBe(' AB ');
  });
});
