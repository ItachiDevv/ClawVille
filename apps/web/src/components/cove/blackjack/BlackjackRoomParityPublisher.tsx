'use client';

import { useEffect, useRef } from 'react';
import { advanceBlackjackRoomParity } from '@/lib/cove/blackjack-room-parity';
import type { BlackjackRoomState } from '@/lib/cove/use-blackjack-room-controller';

/**
 * Journals the 3D blackjack room's committed display state. Mounts at PAGE
 * level, OUTSIDE the Canvas/Suspense subtree (Codex MAJOR-A review, B2): the
 * HUD's Deal button is clickable before the room GLBs resolve, so a publisher
 * inside the suspended scene could miss whole revisions — a dealt natural
 * could traverse hole -> settled before it ever mounted. Page-level mounting
 * is unconditional (the baccarat room publishes the same way).
 */
export function BlackjackRoomParityPublisher({
  instanceId,
  view,
}: {
  instanceId: string;
  view: BlackjackRoomState;
}) {
  const revealSpanRef = useRef<number | null>(null);

  useEffect(() => {
    revealSpanRef.current = advanceBlackjackRoomParity(
      instanceId,
      view,
      revealSpanRef.current,
    );
  }, [instanceId, view.dealStep, view.publishSeq]);

  return null;
}
