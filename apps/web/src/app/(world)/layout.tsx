import type { ReactNode } from 'react';
import { WorldStageRoot } from '@/components/three/world-stage/WorldStageRoot';

export default function WorldRouteGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <WorldStageRoot>{children}</WorldStageRoot>;
}
