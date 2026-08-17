'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { HoldemControllerRuntime } from '@/lib/cove/holdem-controller';
import {
  CashTableRoomHud,
  SeatedHoldemHud,
} from '@/components/cove/holdem/SeatedHoldemHud';
import { TableLobby } from '@/components/cove/holdem/TableLobby';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useAvatar } from '@/hooks/use-avatar';
import { useCoveStore } from '@/stores/cove';
import {
  cashPokerApi,
  CoveApiError,
  describeCashPokerError,
  type CashAction,
  type CashAgentView,
  type PublicTableStateResponse,
} from '@/lib/cove/cash-poker';
import type { LiveTableRoomState } from '@/lib/three/holdem-table-room';
import { clearFeltParity } from '@/lib/cove/card-parity-mirror';
import type { CashSettledHandSnapshot } from '@clawville/shared';
import styles from '@/components/cove/holdem/SeatedHoldemHud.module.css';

const PUBLIC_POLL_MS = 3000;
const SELF_POLL_MS = 1500;

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
  if (!tableId) return <CashTableLobbyRoom isAuthenticated={isLoggedIn} />;
  if (!isLoggedIn) return <PracticeDemoRoom />;
  return <CashTableRoom tableId={tableId} />;
}

function RoomLoading() {
  const instanceId = useRef(crypto.randomUUID()).current;
  useEffect(() => () => clearFeltParity(instanceId), [instanceId]);
  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}>
      <HoldemTableRoomCanvas
        instanceId={instanceId}
        liveTable={{ table: null, povSeatIndex: 0, settled: null }}
      />
    </main>
  );
}

function PracticeDemoRoom() {
  const router = useRouter();
  const instanceId = useRef(crypto.randomUUID()).current;
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const wasSeatedRef = useRef(false);

  useEffect(() => {
    useCoveStore.getState().sitAtTable('T1', 0);
    return () => {
      useCoveStore.getState().standFromTable();
      clearFeltParity(instanceId);
    };
  }, [instanceId]);

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
      <HoldemTableRoomCanvas instanceId={instanceId} />
      <ParityMirror surface="holdem-felt-practice" instanceId={instanceId} />
      <HoldemControllerRuntime />
      <SeatedHoldemHud instanceId={instanceId} />
    </RoomShell>
  );
}

function CashTableRoom({ tableId }: { tableId: string }) {
  const router = useRouter();
  const instanceId = useRef(crypto.randomUUID()).current;
  const { data: avatar } = useAvatar();
  const [state, setState] = useState<PublicTableStateResponse | null>(null);
  const [settled, setSettled] = useState<CashSettledHandSnapshot | null>(null);
  const [pollNotice, setPollNotice] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [selfView, setSelfView] = useState<CashAgentView | null>(null);
  const [sitting, setSitting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveQueued, setLeaveQueued] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [cashedOutCt, setCashedOutCt] = useState<number | null>(null);
  const [seatedSeatIndex, setSeatedSeatIndex] = useState<number | null>(null);
  const actionSeqRef = useRef(0);
  const lastKnownStackRef = useRef(0);
  const lastSettledHandRef = useRef(0);
  const wasSeatedRef = useRef(false);

  useEffect(() => () => clearFeltParity(instanceId), [instanceId]);
  useEffect(() => {
    lastSettledHandRef.current = 0;
    setSettled(null);
  }, [tableId]);

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

  const amSeated = useMemo(
    () => Boolean(avatar?.id && state?.seats.some((seat) => seat.avatarId === avatar.id)),
    [avatar?.id, state?.seats],
  );

  useEffect(() => {
    if (!amSeated) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const snapshot = await cashPokerApi.lastSettled(tableId, lastSettledHandRef.current);
        if (!cancelled && snapshot) {
          lastSettledHandRef.current = snapshot.handNumber;
          setSettled(Date.now() < snapshot.displayExpiresAtMs ? snapshot : null);
        }
      } catch (error) {
        if (!cancelled && !(error instanceof CoveApiError && error.status === 403)) {
          setPollNotice(`${describeCashPokerError(error)} Retrying…`);
        }
      } finally {
        if (!cancelled) timer = setTimeout(tick, PUBLIC_POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [amSeated, tableId]);

  useEffect(() => {
    if (!settled) return;
    const remainingMs = settled.displayExpiresAtMs - Date.now();
    if (remainingMs <= 0) {
      setSettled(null);
      return;
    }
    const timer = window.setTimeout(() => setSettled(null), remainingMs);
    return () => window.clearTimeout(timer);
  }, [settled]);

  useEffect(() => {
    if (!amSeated) {
      setSelfView(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const result = await cashPokerApi.stateForAgent(tableId);
        if (!cancelled) {
          setSelfView(result.view);
          lastKnownStackRef.current = result.view.chipStack;
        }
      } catch (error) {
        if (!cancelled) {
          if (error instanceof CoveApiError && error.status === 409) {
            setSelfView(null);
          } else if (error instanceof CoveApiError && (error.status === 401 || error.status === 403)) {
            setSelfView(null);
          } else {
            setPollNotice(`${describeCashPokerError(error)} Retrying…`);
          }
        }
      } finally {
        if (!cancelled) timer = setTimeout(tick, SELF_POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [amSeated, tableId]);

  useEffect(() => {
    if (amSeated) {
      wasSeatedRef.current = true;
      const liveOwnSeat = state?.live?.seats.find((seat) => seat.avatarId === avatar?.id);
      if (liveOwnSeat) lastKnownStackRef.current = liveOwnSeat.chipStack;
      return;
    }
    if (leaveQueued && wasSeatedRef.current) {
      setLeaveQueued(false);
      setCashedOutCt(lastKnownStackRef.current);
    }
  }, [amSeated, avatar?.id, leaveQueued, state?.live?.seats]);

  const povSeatIndex = useMemo(() => {
    if (seatedSeatIndex != null) return seatedSeatIndex;
    if (!avatar?.id || !state) return 0;
    return state.seats.find((seat) => seat.avatarId === avatar.id)?.seatIndex ?? 0;
  }, [avatar?.id, seatedSeatIndex, state]);
  const liveTable = useMemo<LiveTableRoomState>(
    () => ({ table: state, povSeatIndex, settled }),
    [povSeatIndex, settled, state],
  );
  const handleBack = useCallback(() => router.push('/cove'), [router]);
  const handleSit = useCallback(async () => {
    if (!state || sitting) return;
    setSitting(true);
    setActionNotice(null);
    setCashedOutCt(null);
    try {
      const result = await cashPokerApi.sit(tableId, Number(state.table.buyInCt));
      setSeatedSeatIndex(result.seatIndex);
      lastKnownStackRef.current = Number(result.stackCt);
      const fresh = await cashPokerApi.publicTableState(tableId);
      setState(fresh);
    } catch (error) {
      setActionNotice(error instanceof CoveApiError && error.status === 402
        ? 'Not enough vCLAW for this buy-in.'
        : describeCashPokerError(error));
    } finally {
      setSitting(false);
    }
  }, [sitting, state, tableId]);

  const handleLeave = useCallback(async () => {
    if (!amSeated || leaving || leaveQueued) return;
    setLeaving(true);
    setActionNotice(null);
    try {
      const result = await cashPokerApi.leave(tableId);
      if (result.queued || result.httpStatus === 202) {
        setLeaveQueued(true);
      } else {
        setCashedOutCt(result.cashedOutCt);
        setSeatedSeatIndex(null);
        const fresh = await cashPokerApi.publicTableState(tableId);
        setState(fresh);
      }
    } catch (error) {
      setActionNotice(describeCashPokerError(error));
    } finally {
      setLeaving(false);
    }
  }, [amSeated, leaveQueued, leaving, tableId]);

  const handleAction = useCallback(async (action: CashAction) => {
    const live = state?.live;
    const freshSelf = live && selfView?.handNumber === live.handNumber ? selfView : null;
    if (!freshSelf?.isYourTurn || actionBusy) return;
    setActionBusy(true);
    setActionNotice(null);
    const actionSeq = actionSeqRef.current;
    actionSeqRef.current += 1;
    try {
      await cashPokerApi.submitAction(tableId, {
        handNumber: freshSelf.handNumber,
        actionSeq,
        action,
      });
      setSelfView((current) => current ? { ...current, isYourTurn: false, legalActions: [] } : null);
    } catch (error) {
      if (error instanceof CoveApiError && error.status === 409) {
        // not_your_turn / hand_over: the next poll is authoritative.
        setSelfView(null);
      } else if (error instanceof CoveApiError && error.status === 422) {
        // Legal bounds moved; discard them and let the 1.5s self poll refill.
        setSelfView(null);
      } else if (error instanceof CoveApiError && error.status === 402) {
        setActionNotice('Not enough vCLAW for that action.');
      } else {
        setActionNotice(describeCashPokerError(error));
      }
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, selfView, state?.live, tableId]);

  const handleStandOrBack = useCallback(() => {
    if (amSeated) void handleLeave();
    else handleBack();
  }, [amSeated, handleBack, handleLeave]);

  useStandKey(handleStandOrBack);

  return (
    <RoomShell
      onBack={handleStandOrBack}
      backLabel={amSeated ? (leaveQueued ? 'Cashing out…' : leaving ? 'Standing…' : 'Walk Away') : 'Back to Cove'}
      backDisabled={leaveQueued || leaving}
    >
      <HoldemTableRoomCanvas instanceId={instanceId} liveTable={liveTable} />
      <ParityMirror surface="holdem-felt-3d" instanceId={instanceId} />
      <CashTableRoomHud
        instanceId={instanceId}
        state={state}
        selfView={selfView}
        settled={settled}
        povSeatIndex={povSeatIndex}
        amSeated={amSeated}
        sitting={sitting}
        leaving={leaving}
        leaveQueued={leaveQueued}
        actionBusy={actionBusy}
        pollNotice={pollNotice}
        actionNotice={actionNotice}
        cashedOutCt={cashedOutCt}
        onSit={() => { void handleSit(); }}
        onLeave={() => { void handleLeave(); }}
        onAction={(action) => { void handleAction(action); }}
      />
      <AvatarChatBar surface="table" />
    </RoomShell>
  );
}

function CashTableLobbyRoom({ isAuthenticated }: { isAuthenticated: boolean }) {
  const router = useRouter();
  const instanceId = useRef(crypto.randomUUID()).current;
  useEffect(() => () => clearFeltParity(instanceId), [instanceId]);

  const handleBack = useCallback(() => router.push('/cove'), [router]);
  useStandKey(handleBack);

  return (
    <RoomShell onBack={handleBack}>
      <HoldemTableRoomCanvas
        instanceId={instanceId}
        liveTable={{ table: null, povSeatIndex: 0, settled: null }}
      />
      <TableLobby isAuthenticated={isAuthenticated} pollMs={PUBLIC_POLL_MS} />
    </RoomShell>
  );
}

function RoomShell({
  children,
  onBack,
  backLabel = 'Back to Cove',
  backDisabled = false,
}: {
  children: React.ReactNode;
  onBack: () => void;
  backLabel?: string;
  backDisabled?: boolean;
}) {
  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}>
      <div style={{ position: 'absolute', inset: 0 }}>{children}</div>
      <button
        type="button"
        onClick={onBack}
        disabled={backDisabled}
        aria-label={backLabel}
        className={styles.backButton}
      >
        ← {backLabel}
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
