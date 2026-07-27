import type { ReactNode } from 'react';
import { WorldStageRoot } from '@/components/three/world-stage/WorldStageRoot';
import { WorldPresence } from '@/components/three/world-stage/WorldPresence';

export default function WorldRouteGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <WorldPresence />
      <WorldStageRoot>{children}</WorldStageRoot>
    </>
  );
}
