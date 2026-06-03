import { useEffect, useState } from 'react';
import type { Placement, Scene } from '@animus-labs/brand';

/**
 * The director. Advances through scenes on each scene's hold and returns the
 * current placements. Pass a stable scenes array (module constant or memoized).
 */
export function useSceneCycle(scenes: Scene[]): Placement[] {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (scenes.length <= 1) return;
    const hold = scenes[index % scenes.length]?.hold ?? 4000;
    const id = setTimeout(
      () => setIndex((i) => (i + 1) % scenes.length),
      hold,
    );
    return () => clearTimeout(id);
  }, [index, scenes]);

  return scenes[index % scenes.length]?.placements ?? [];
}
