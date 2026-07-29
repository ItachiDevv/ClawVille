'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import { BlackjackRoomParityPublisher } from '@/components/cove/blackjack/BlackjackRoomParityPublisher';
import { SeatedBlackjackHud } from '@/components/cove/blackjack/SeatedBlackjackHud';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useIsGuest } from '@/hooks/use-is-guest';
import { clearFeltParity } from '@/lib/cove/card-parity-mirror';
import { useBlackjackRoomController } from '@/lib/cove/use-blackjack-room-controller';

const BlackjackTableRoomCanvas = dynamic(
  () => import('@/lib/three/blackjack-table-room'),
  {
    ssr: false,
    loading: () => (
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: '#100b16',
        color: '#f3ead8',
        fontFamily: 'monospace',
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
      }}>
        Preparing the table…
      </div>
    ),
  },
);

export default function BlackjackTableRoomPage() {
  const instanceId = useRef(crypto.randomUUID()).current;
  const controller = useBlackjackRoomController();
  const { isLoading } = useAuthMe();
  const isGuest = useIsGuest();

  useEffect(() => () => clearFeltParity(instanceId), [instanceId]);

  return (
    <main
      data-tier={controller.isRealTier && !isGuest ? 'real' : 'demo'}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}
    >
      <BlackjackTableRoomCanvas view={controller} instanceId={instanceId} />
      <BlackjackRoomParityPublisher instanceId={instanceId} view={controller} />
      <ParityMirror surface="blackjack-3d" instanceId={instanceId} />
      <SeatedBlackjackHud controller={controller} />
      {isLoading && (
        <div
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 62,
            padding: '8px 12px',
            border: '1px solid rgba(212, 175, 55, 0.52)',
            borderRadius: 8,
            background: 'rgba(26, 18, 28, 0.9)',
            color: '#f3ead8',
            font: '800 10px/1.2 monospace',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          Checking table tier…
        </div>
      )}
    </main>
  );
}
