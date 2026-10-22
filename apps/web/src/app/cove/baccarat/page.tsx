'use client';

/**
 * /cove/baccarat routes (spec ~/.clawville-brain/plans/baccarat-shared-table-port-2026-10-22.md section 7.1):
 *   /cove/baccarat                 -> shared-table lobby (three house tables + private shoe card)
 *   /cove/baccarat?mode=solo       -> the private-shoe room (unchanged; guests' demo shoe)
 *   /cove/baccarat?tableId=<uuid>  -> a shared table (logged-out and guest viewers watch only)
 *
 * ONE room Canvas for all three modes. Next keeps this page instance across
 * search-param pushes (the layout router's state key has no search params),
 * so the Canvas sits at a fixed position with a constant key: lobby -> table,
 * table -> table and table -> lobby only change its props. The renderer, the
 * uploaded textures and the compiled pipelines survive; before, each mode
 * mounted its own Canvas and rebuilt them all. The per-mode overlays (HUD,
 * lobby cards, controller runtimes) mount beside it; the shared overlay is
 * keyed by tableId so a table switch still resets the table controller.
 */

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef } from 'react';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import { BaccaratTableLobby, tableRoomHref } from '@/components/cove/baccarat/BaccaratTableLobby';
import { SeatedBaccaratHud } from '@/components/cove/baccarat/SeatedBaccaratHud';
import { SharedBaccaratHud } from '@/components/cove/baccarat/SharedBaccaratHud';
import { useAuthMe } from '@/hooks/use-auth-me';
import {
  BaccaratControllerRuntime,
  useBaccaratRoomController,
} from '@/lib/cove/baccarat-room-controller';
import {
  BaccaratTableControllerRuntime,
  useBaccaratTableController,
  useBaccaratTableFeltView,
} from '@/lib/cove/baccarat-table-controller';
import { clearFeltParity } from '@/lib/cove/card-parity-mirror';
import type { BaccaratRoomMode } from '@/lib/three/baccarat-table-room';

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

/**
 * The room canvas host. `soloFeltView` and the mode -> props mapping live in
 * the 3D module, so they run inside this dynamic chunk: a static import would
 * pull three.js and its GLTF preloads into the page chunk and the server
 * render.
 */
const BaccaratRoomCanvasHost = dynamic(
  () => import('@/lib/three/baccarat-table-room').then((mod) => mod.BaccaratRoomCanvasHost),
  { ssr: false, loading: TableLoading },
);

interface PageSearchParams {
  mode?: string | string[];
  tableId?: string | string[];
}

const MAIN_STYLE = { position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' } as const;

export default function BaccaratPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const query = use(searchParams);
  const modeParam = typeof query.mode === 'string' ? query.mode : null;
  const tableId = typeof query.tableId === 'string' && query.tableId ? query.tableId : null;
  const mode: BaccaratRoomMode = modeParam === 'solo' ? 'solo' : tableId ? 'shared' : 'lobby';
  // One felt instance for the page's one canvas (dealer VRM id, card parity).
  const instanceId = useRef(crypto.randomUUID()).current;
  const { data: authData, isLoading } = useAuthMe();
  const isRealTier = Boolean(authData?.user && !authData.user.isGuest);
  const isGuest = Boolean(authData?.user?.isGuest);

  useEffect(() => () => clearFeltParity(instanceId), [instanceId]);

  const dataTier = mode === 'solo'
    ? (isRealTier ? 'real' : 'demo')
    : mode === 'shared'
      ? (isRealTier ? 'real' : 'spectator')
      : undefined;

  return (
    <main data-tier={dataTier} style={MAIN_STYLE}>
      <BaccaratRoomCanvasSlot key="baccarat-room-canvas" mode={mode} instanceId={instanceId} />
      {mode === 'lobby' ? (
        <BaccaratTableLobby isRealTier={isRealTier} isGuest={isGuest} authPending={isLoading} />
      ) : null}
      {mode === 'shared' && tableId ? (
        <SharedBaccaratOverlay
          key={tableId}
          tableId={tableId}
          isRealTier={isRealTier}
          isGuest={isGuest}
          authPending={isLoading}
        />
      ) : null}
      {mode === 'solo' ? (
        <SoloBaccaratOverlay instanceId={instanceId} isRealTier={isRealTier} authPending={isLoading} />
      ) : null}
    </main>
  );
}

/**
 * Reads every mode's store (hooks cannot vary by mode, and the host must stay
 * the same component at the same position) and hands them to the host, which
 * maps them by mode. Only 'shared' passes seats to the room.
 */
function BaccaratRoomCanvasSlot({ mode, instanceId }: { mode: BaccaratRoomMode; instanceId: string }) {
  const soloController = useBaccaratRoomController();
  const sharedView = useBaccaratTableFeltView();
  const sharedSeats = useBaccaratTableController((state) => state.table?.seats);
  const sharedPovSeatIndex = useBaccaratTableController((state) => (
    state.table?.me?.seated ? state.table.me.seatIndex : null
  ));
  return (
    <BaccaratRoomCanvasHost
      instanceId={instanceId}
      mode={mode}
      soloController={soloController}
      sharedView={sharedView}
      sharedSeats={sharedSeats}
      sharedPovSeatIndex={sharedPovSeatIndex}
    />
  );
}

function SharedBaccaratOverlay({
  tableId,
  isRealTier,
  isGuest,
  authPending,
}: {
  tableId: string;
  isRealTier: boolean;
  isGuest: boolean;
  authPending: boolean;
}) {
  const router = useRouter();
  const handleBackToLobby = useCallback(() => router.push('/cove/baccarat'), [router]);
  const handleSignIn = useCallback(() => router.push('/login'), [router]);
  const handleOpenTable = useCallback(
    (otherTableId: string) => router.push(tableRoomHref(otherTableId)),
    [router],
  );

  return (
    <>
      <BaccaratTableControllerRuntime tableId={tableId} />
      <SharedBaccaratHud
        isRealTier={isRealTier}
        isGuest={isGuest}
        authPending={authPending}
        onBackToLobby={handleBackToLobby}
        onSignIn={handleSignIn}
        onOpenTable={handleOpenTable}
      />
      {isRealTier && <AvatarChatBar surface="table" />}
    </>
  );
}

function SoloBaccaratOverlay({
  instanceId,
  isRealTier,
  authPending,
}: {
  instanceId: string;
  isRealTier: boolean;
  authPending: boolean;
}) {
  const controller = useBaccaratRoomController();

  return (
    <>
      <ParityMirror surface="baccarat-3d" instanceId={instanceId} />
      <BaccaratControllerRuntime instanceId={instanceId} />
      <SeatedBaccaratHud controller={controller} />
      {isRealTier && <AvatarChatBar surface="table" />}
      {authPending && (
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
    </>
  );
}
