import { createFileRoute } from '@tanstack/react-router';
import { SplitFlapGrid } from '../components/SplitFlapGrid';
import { useSceneCycle } from '../lib/useSceneCycle';
import { HERO_SCENES } from '../lib/scenes';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  const placements = useSceneCycle(HERO_SCENES);
  return (
    <main className="hero">
      <SplitFlapGrid rows={7} cols={21} placements={placements} />
    </main>
  );
}
