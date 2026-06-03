import { type CSSProperties, useMemo } from 'react';
import { composite, flapTiming, type Placement } from '@animus-labs/brand';
import { SplitFlapCell } from './SplitFlapCell';

interface SplitFlapGridProps {
  rows: number;
  cols: number;
  /** The desired board. Cells animate the diff when this changes. */
  placements: Placement[];
  /** Per-step delay for the diagonal settle wave, ms. */
  staggerMs?: number;
}

/**
 * A declarative grid of cells. You set the desired board via `placements`; the
 * compositor turns it into per-cell targets and each cell riffles the diff.
 * Unchanged cells don't move. A diagonal wave staggers the settle.
 */
export function SplitFlapGrid({
  rows,
  cols,
  placements,
  staggerMs = flapTiming.cellStaggerMs,
}: SplitFlapGridProps) {
  const targets = useMemo(
    () => composite(placements, rows, cols),
    [placements, rows, cols],
  );
  const label = useMemo(() => placements.map((p) => p.text).join('  '), [placements]);
  const style = { '--cols': cols } as CSSProperties;

  return (
    <div className="grid" style={style} role="img" aria-label={label}>
      {targets.map((ch, i) => (
        <SplitFlapCell
          key={i}
          char={ch}
          startDelay={(Math.floor(i / cols) + (i % cols)) * staggerMs}
        />
      ))}
    </div>
  );
}
