'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import { SeatedBaccaratHud } from '@/components/cove/baccarat/SeatedBaccaratHud';
import { useAuthMe } from '@/hooks/use-auth-me';
import {
  BaccaratControllerRuntime,
  useBaccaratRoomController,
} from '@/lib/cove/baccarat-room-controller';
import { clearFeltParity } from '@/lib/cove/card-parity-mirror';

const BaccaratTableRoomCanvas = dynamic(
  () => import('@/lib/three/baccarat-table-room'),
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

export default function BaccaratTableRoomPage() {
  const instanceId = useRef(crypto.randomUUID()).current;
  const controller = useBaccaratRoomController();
  const { data: authData, isLoading } = useAuthMe();
  const isRealTier = Boolean(authData?.user && !authData.user.isGuest);

  useEffect(() => () => clearFeltParity(instanceId), [instanceId]);

  return (
    <main
      data-tier={isRealTier ? 'real' : 'demo'}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}
    >
      <BaccaratTableRoomCanvas view={controller} instanceId={instanceId} />
      <ParityMirror surface="baccarat-3d" instanceId={instanceId} />
      <BaccaratControllerRuntime instanceId={instanceId} />
      <SeatedBaccaratHud controller={controller} />
      {isRealTier && <AvatarChatBar surface="table" />}
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
