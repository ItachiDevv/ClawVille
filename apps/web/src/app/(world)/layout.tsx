import type { ReactNode } from 'react';
import { WorldStageRoot } from '@/components/three/world-stage/WorldStageRoot';
import { WorldPresence } from '@/components/three/world-stage/WorldPresence';
import { BootSplash } from '@/components/game/boot-splash';

export const dynamic = 'force-dynamic';

export default function WorldRouteGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <BootSplash />
      <WorldPresence />
      <WorldStageRoot>{children}</WorldStageRoot>
    </>
  );
}
