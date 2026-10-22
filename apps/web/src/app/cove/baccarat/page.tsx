'use client';

/**
 * /cove/baccarat routes (spec ~/.clawville-brain/plans/baccarat-shared-table-port-2026-10-22.md section 7.1):
 *   /cove/baccarat                 -> shared-table lobby (three house tables + private shoe card)
 *   /cove/baccarat?mode=solo       -> the private-shoe room (unchanged; guests' demo shoe)
 *   /cove/baccarat?tableId=<uuid>  -> a shared table (logged-out and guest viewers watch only)
 */

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useMemo, useRef } from 'react';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import { BaccaratTableLobby, tableRoomHref } from '@/components/cove/baccarat/BaccaratTableLobby';
import { SeatedBaccaratHud } from '@/components/cove/baccarat/SeatedBaccaratHud';
import { SharedBaccaratHud } from '@/components/cove/baccarat/SharedBaccaratHud';
import { useAuthMe } from '@/hooks/use-auth-me';
import {
  BaccaratControllerRuntime,
  useBaccaratRoomController,
  type BaccaratRoomState,
} from '@/lib/cove/baccarat-room-controller';
import {
  BaccaratTableControllerRuntime,
  useBaccaratTableController,
  useBaccaratTableFeltView,
} from '@/lib/cove/baccarat-table-controller';
import { clearFeltParity } from '@/lib/cove/card-parity-mirror';
import type { BaccaratFeltView } from '@/lib/three/baccarat-table-room';

function TableLoading() {
  return (
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
  );
}

const BaccaratTableRoomCanvas = dynamic(
  () => import('@/lib/three/baccarat-table-room'),
  { ssr: false, loading: TableLoading },
);

/**
 * Solo room canvas. `soloFeltView` lives in the 3D module, so it runs inside
 * the dynamic chunk: a static import would pull three.js and its GLTF
 * preloads into the page chunk and the server render. The memo keeps the old
 * identity rule (a new view only when the solo controller state changes).
 */
const SoloBaccaratTableRoomCanvas = dynamic(
  () => import('@/lib/three/baccarat-table-room').then((mod) => {
    const RoomCanvas = mod.default;
    function SoloRoomCanvas({
      controller,
      instanceId,
    }: {
      controller: BaccaratRoomState;
      instanceId: string;
    }) {
      const view = useMemo(() => mod.soloFeltView(controller), [controller]);
      return <RoomCanvas view={view} instanceId={instanceId} />;
    }
    return SoloRoomCanvas;
  }),
  { ssr: false, loading: TableLoading },
);

interface PageSearchParams {
  mode?: string | string[];
  tableId?: string | string[];
}

/** Felt with no cards and no bet zone picked (lobby background). */
const EMPTY_FELT_VIEW: BaccaratFeltView = {
  coup: null,
  revealedStep: 0,
  dealSteps: [],
  phase: 'idle',
  betType: 'player',
  stake: 0,
  correlation: null,
  shoeId: null,
  bannerText: null,
  betzoneSelected: null,
};

export default function BaccaratPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const query = use(searchParams);
  const mode = typeof query.mode === 'string' ? query.mode : null;
  const tableId = typeof query.tableId === 'string' && query.tableId ? query.tableId : null;
  if (mode === 'solo') return <SoloBaccaratRoom />;
  if (tableId) return <SharedBaccaratRoom key={tableId} tableId={tableId} />;
  return <BaccaratLobbyRoom />;
}

function BaccaratLobbyRoom() {
  const instanceId = useRef(crypto.randomUUID()).current;
  const { data: authData, isLoading } = useAuthMe();
  const isRealTier = Boolean(authData?.user && !authData.user.isGuest);
  const isGuest = Boolean(authData?.user?.isGuest);

  useEffect(() => () => clearFeltParity(instanceId), [instanceId]);

  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}>
      <BaccaratTableRoomCanvas view={EMPTY_FELT_VIEW} instanceId={instanceId} />
      <BaccaratTableLobby isRealTier={isRealTier} isGuest={isGuest} authPending={isLoading} />
    </main>
  );
}

function SharedBaccaratRoom({ tableId }: { tableId: string }) {
  const router = useRouter();
  const instanceId = useRef(crypto.randomUUID()).current;
  const { data: authData, isLoading } = useAuthMe();
  const isRealTier = Boolean(authData?.user && !authData.user.isGuest);
  const isGuest = Boolean(authData?.user?.isGuest);
  const feltView = useBaccaratTableFeltView();
  const seats = useBaccaratTableController((state) => state.table?.seats);
  const mySeatIndex = useBaccaratTableController((state) => (
    state.table?.me?.seated ? state.table.me.seatIndex : null
  ));
  const roomSeats = useMemo(() => seats ?? [], [seats]);

  useEffect(() => () => clearFeltParity(instanceId), [instanceId]);

  const handleBackToLobby = useCallback(() => router.push('/cove/baccarat'), [router]);
  const handleSignIn = useCallback(() => router.push('/login'), [router]);
  const handleOpenTable = useCallback(
    (otherTableId: string) => router.push(tableRoomHref(otherTableId)),
    [router],
  );

  return (
    <main
      data-tier={isRealTier ? 'real' : 'spectator'}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}
    >
      <BaccaratTableRoomCanvas
        view={feltView}
        instanceId={instanceId}
        seats={roomSeats}
        povSeatIndex={mySeatIndex}
      />
      <BaccaratTableControllerRuntime tableId={tableId} />
      <SharedBaccaratHud
        isRealTier={isRealTier}
        isGuest={isGuest}
        authPending={isLoading}
        onBackToLobby={handleBackToLobby}
        onSignIn={handleSignIn}
        onOpenTable={handleOpenTable}
      />
      {isRealTier && <AvatarChatBar surface="table" />}
    </main>
  );
}

function SoloBaccaratRoom() {
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
      <SoloBaccaratTableRoomCanvas controller={controller} instanceId={instanceId} />
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
