import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { flapAlphabet, flapTiming, flapDistance, flipSchedule } from '@animus-labs/brand';

/**
 * One physical split-flap cell. Lit from above. Reaches a target `char` by
 * riffling forward through the alphabet, the way a real Solari unit can only
 * advance, never reverse. Each flip's duration comes from the shared motion
 * profile, so the cell spins up, cruises, and brakes on its own.
 */

function normalize(ch: string): string {
  const up = ch.toUpperCase();
  return flapAlphabet.includes(up) ? up : ' ';
}

function nextChar(ch: string): string {
  const i = flapAlphabet.indexOf(ch);
  return flapAlphabet[(i + 1) % flapAlphabet.length]!;
}

interface SplitFlapCellProps {
  char: string;
  /** Wave offset: delay before this cell begins a new journey, ms. */
  startDelay?: number;
}

export function SplitFlapCell({ char, startDelay = 0 }: SplitFlapCellProps) {
  const target = normalize(char);
  const [state, setState] = useState<{
    display: string;
    prev: string;
    flipping: boolean;
    flipMs: number;
  }>(() => ({
    display: target,
    prev: target,
    flipping: false,
    flipMs: flapTiming.topMs,
  }));

  const displayRef = useRef(state.display);
  displayRef.current = state.display;

  // Drive a riffle whenever the target changes. Recomputes the journey (and its
  // speed schedule) from wherever the cell currently sits.
  useEffect(() => {
    if (displayRef.current === target) return;

    const schedule = flipSchedule(flapDistance(displayRef.current, target) || 1);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let step = 0;
    let cancelled = false;

    const flipOnce = () => {
      if (cancelled) return;
      const display = displayRef.current;
      if (display === target) return;
      const flipMs = schedule[Math.min(step, schedule.length - 1)] ?? flapTiming.topMs;
      const upcoming = nextChar(display);
      displayRef.current = upcoming;
      setState({ display: upcoming, prev: display, flipping: true, flipMs });
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setState((s) => ({ ...s, flipping: false }));
          step += 1;
          timers.push(setTimeout(flipOnce, 0));
        }, flipMs),
      );
    };

    timers.push(setTimeout(flipOnce, startDelay));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [target, startDelay]);

  const style = { '--flip-ms': `${state.flipMs}ms` } as CSSProperties;
  const { display, prev, flipping } = state;

  return (
    <div className={`flap${flipping ? ' flap--flipping' : ''}`} style={style}>
      {/* Static halves: top shows the new char (revealed as the leaf falls),
          bottom shows the old char until the rising leaf lands over it. */}
      <div className="flap__half flap__half--top">
        <span className="flap__char">{display}</span>
      </div>
      <div className="flap__half flap__half--bottom">
        <span className="flap__char">{flipping ? prev : display}</span>
      </div>

      {flipping && (
        <>
          <div className="flap__leaf flap__leaf--top" key={`t${prev}${display}`}>
            <span className="flap__char">{prev}</span>
            <span className="flap__shade" />
          </div>
          <div className="flap__leaf flap__leaf--bottom" key={`b${prev}${display}`}>
            <span className="flap__char">{display}</span>
            <span className="flap__shade" />
          </div>
          <span className="flap__cast" />
        </>
      )}

      <span className="flap__axle" />
    </div>
  );
}
