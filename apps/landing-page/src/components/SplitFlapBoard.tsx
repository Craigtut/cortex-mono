import { useMemo } from 'react';
import type { Scene } from '@animus-labs/brand';
import { SplitFlapGrid } from './SplitFlapGrid';
import { useSceneCycle } from '../lib/useSceneCycle';

interface SplitFlapBoardProps {
  messages: string[];
  /** How long each message rests before the next, ms. */
  intervalMs?: number;
}

/**
 * A single centered row that cycles through messages. A one-row case of the
 * grid: each message becomes a one-placement scene.
 */
export function SplitFlapBoard({ messages, intervalMs = 3200 }: SplitFlapBoardProps) {
  const cols = Math.max(1, ...messages.map((m) => m.length));
  const scenes = useMemo<Scene[]>(
    () =>
      messages.map((m) => ({
        hold: intervalMs,
        placements: [{ text: m, row: 0, align: 'center' as const }],
      })),
    [messages, intervalMs],
  );
  const placements = useSceneCycle(scenes);
  return <SplitFlapGrid rows={1} cols={cols} placements={placements} />;
}
