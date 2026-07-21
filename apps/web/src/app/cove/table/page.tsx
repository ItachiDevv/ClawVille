'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { HoldemControllerRuntime } from '@/lib/cove/holdem-controller';
import {
  CashTableSpectateHud,
  SeatedHoldemHud,
} from '@/components/cove/holdem/SeatedHoldemHud';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useAvatar } from '@/hooks/use-avatar';
import { useCoveStore } from '@/stores/cove';
import {
  cashPokerApi,
  CASH_TIERS,
  describeCashPokerError,
  type CashTableListItem,
  type PublicTableStateResponse,
} from '@/lib/cove/cash-poker';
import type { LiveTableRoomState } from '@/lib/three/holdem-table-room';
import styles from '@/components/cove/holdem/SeatedHoldemHud.module.css';

const PUBLIC_POLL_MS = 3000;

const HoldemTableRoomCanvas = dynamic(
  () => import('@/lib/three/holdem-table-room'),
  {
    ssr: false,
    loading: () => (
      <div style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        background: '#100b16', color: '#f3ead8', fontFamily: 'monospace',
        fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase',
      }}>
        Preparing the table…
      </div>
    ),
  },
);

interface PageSearchParams {
  tableId?: string | string[];
}

export default function HoldemTableRoomPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const query = use(searchParams);
  const { data: authData, isLoading } = useAuthMe();
  const tableId = typeof query.tableId === 'string' ? query.tableId : null;
  const isLoggedIn = Boolean(authData?.user && !authData.user.isGuest);

  if (isLoading) return <RoomLoading />;
  if (!isLoggedIn) return <PracticeDemoRoom />;
  if (tableId) return <CashTableRoom tableId={tableId} />;
  return <CashTablePicker />;
}

function RoomLoading() {
  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}>
      <HoldemTableRoomCanvas liveTable={{ table: null, povSeatIndex: 0 }} />
    </main>
  );
}

function PracticeDemoRoom() {
  const router = useRouter();
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const wasSeatedRef = useRef(false);

  useEffect(() => {
    useCoveStore.getState().sitAtTable('T1', 0);
    return () => { useCoveStore.getState().standFromTable(); };
  }, []);

  useEffect(() => {
    if (seatedTable?.tableId === 'T1') {
      wasSeatedRef.current = true;
      return;
    }
    if (wasSeatedRef.current) router.push('/cove');
  }, [router, seatedTable]);

  const handleBack = useCallback(() => {
    useCoveStore.getState().standFromTable();
    router.push('/cove');
  }, [router]);

  useStandKey(handleBack);

  return (
    <RoomShell onBack={handleBack}>
      <HoldemTableRoomCanvas />
      <HoldemControllerRuntime />
      <SeatedHoldemHud />
    </RoomShell>
  );
}

function CashTableRoom({ tableId }: { tableId: string }) {
  const router = useRouter();
  const { data: avatar } = useAvatar();
  const [state, setState] = useState<PublicTableStateResponse | null>(null);
  const [pollNotice, setPollNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const next = await cashPokerApi.publicTableState(tableId);
        if (!cancelled) {
          setState(next);
          setPollNotice(null);
        }
      } catch (error) {
        if (!cancelled) setPollNotice(`${describeCashPokerError(error)} Retrying…`);
      } finally {
        if (!cancelled) timer = setTimeout(tick, PUBLIC_POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tableId]);

  const povSeatIndex = useMemo(() => {
    if (!avatar?.id || !state) return 0;
    return state.seats.find((seat) => seat.avatarId === avatar.id)?.seatIndex ?? 0;
  }, [avatar?.id, state]);
  const liveTable = useMemo<LiveTableRoomState>(
    () => ({ table: state, povSeatIndex }),
    [povSeatIndex, state],
  );
  const handleBack = useCallback(() => router.push('/cove'), [router]);

  useStandKey(handleBack);

  return (
    <RoomShell onBack={handleBack}>
      <HoldemTableRoomCanvas liveTable={liveTable} />
      <CashTableSpectateHud
        state={state}
        povSeatIndex={povSeatIndex}
        pollNotice={pollNotice}
      />
      <AvatarChatBar surface="table" />
    </RoomShell>
  );
}

function CashTablePicker() {
  const router = useRouter();
  const [tables, setTables] = useState<CashTableListItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const result = await cashPokerApi.listTables(30);
        if (!cancelled) {
          setTables(result.tables);
          setNotice(null);
        }
      } catch (error) {
        if (!cancelled) setNotice(`${describeCashPokerError(error)} Retrying…`);
      } finally {
        if (!cancelled) timer = setTimeout(tick, PUBLIC_POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleBack = useCallback(() => router.push('/cove'), [router]);
  useStandKey(handleBack);

  return (
    <RoomShell onBack={handleBack}>
      <HoldemTableRoomCanvas liveTable={{ table: null, povSeatIndex: 0 }} />
      <div className={styles.settlement} style={{ width: 'min(680px, calc(100vw - 32px))' }}>
        <div className={styles.settlementHeadline}>Choose a live table</div>
        <div className={styles.settlementDetail}>Cash tables deal automatically while a real player is seated.</div>
        <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
          {tables.map((table) => {
            const tier = table.tierKey && table.tierKey in CASH_TIERS
              ? CASH_TIERS[table.tierKey as keyof typeof CASH_TIERS]
              : null;
            return (
              <button
                key={table.id}
                type="button"
                onClick={() => router.push(`/cove/table?tableId=${encodeURIComponent(table.id)}`)}
                className={styles.actionButton + ' ' + styles.primaryButton}
                style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, textAlign: 'left' }}
              >
                <span>{tier?.label ?? table.tierKey ?? 'Public table'} · {table.smallBlindCt}/{table.bigBlindCt} blinds · {table.buyInCt} vCLAW buy-in</span>
                <span>{table.occupiedSeats}/{table.maxSeats} seated</span>
              </button>
            );
          })}
          {!tables.length && <div className={styles.settlementDetail}>Looking for open house tables…</div>}
          {notice && <div className={styles.toast + ' ' + styles.toastWarn}>{notice}</div>}
        </div>
      </div>
    </RoomShell>
  );
}

function RoomShell({
  children,
  onBack,
}: {
  children: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}>
      <div style={{ position: 'absolute', inset: 0 }}>{children}</div>
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to Cove"
        className={styles.backButton}
      >
        ← Back to Cove
      </button>
    </main>
  );
}

function useStandKey(onStand: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'e' || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
      event.preventDefault();
      onStand();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onStand]);
}
