'use client';

/**
 * CashPokerLobby — the cove DOM-modal entry for Poker CASH GAMES (ring tables).
 *
 * Three tabs in one panel:
 *   (a) BROWSE  — public open tables (GET /tables, polled ~3s) with seats-filled
 *                 + stakes + a Join button (POST /tables/:id/sit → route to felt).
 *   (b) CREATE  — visibility public|private, seats 2..8;
 *                   public → tier picker (House Low / Mid / High);
 *                   private → custom buyIn / SB / BB number inputs;
 *                 optional seeded agent slots. On success, the private host sees
 *                 the join CODE + copy-to-clipboard, then routes to the table.
 *   (c) JOIN    — paste a join code → POST /tables/join-by-code → route to felt.
 *
 * Reuses the canonical cove modal shell + light-on-dark styling (BlackjackModal /
 * HoldemModal palette) + RuneFrame/RpgButton (PokerTournamentLobby model). Branches
 * on `CoveApiError.code` for readable messages, NEVER the raw message string.
 *
 * Mobile/iPad layout via the canonical `useIsMobile()` (maxTouchPoints>1 + coarse
 * pointer) — NOT a bare `md:` query. The launcher tile on /cove sits CLEAR of the
 * cove joystick zones (≈50vw × 240px bottom corners).
 *
 * Iris Xe safe: pure DOM/CSS, no Three.js / WebGPU.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RuneFrame, RpgButton } from '@/components/rpg';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  cashPokerApi,
  describeCashPokerError,
  CASH_TIERS,
  type CashTableListItem,
  type CashTierKey,
  type CreateTableBody,
} from '@/lib/cove/cash-poker';

const LIST_POLL_MS = 3000;

export interface CashPokerLobbyProps {
  open: boolean;
  onClose: () => void;
}

type Tab = 'browse' | 'create' | 'join';

export default function CashPokerLobby({ open, onClose }: CashPokerLobbyProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<Tab>('browse');

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cash poker lobby"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9991,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: isMobile ? 12 : 24,
        background: 'rgba(3,9,10,0.72)',
        backdropFilter: 'blur(5px)',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 540,
          maxHeight: isMobile ? '92vh' : '88vh',
          overflowY: 'auto',
          background:
            'radial-gradient(ellipse 90% 70% at 50% 0%, #0a3325 0%, #06140f 55%, #03090a 100%)',
          border: '1px solid rgba(124,255,203,0.28)',
          borderRadius: 16,
          boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
          padding: isMobile ? 16 : 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div
              style={{
                color: '#7cffcb',
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 11,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                marginBottom: 3,
              }}
            >
              Cove · Cash Poker
            </div>
            <h2
              style={{
                color: '#f0fdf4',
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: isMobile ? 18 : 22,
                fontWeight: 800,
                margin: 0,
                textShadow: '0 0 16px rgba(124,255,203,0.35)',
              }}
            >
              No-Limit Hold&apos;em Ring Tables
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid rgba(124,255,203,0.3)',
              borderRadius: 8,
              color: '#7cffcb',
              width: 44,
              height: 44,
              cursor: 'pointer',
              fontSize: 18,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* Tab switcher */}
        <div style={{ display: 'flex', gap: 6 }}>
          {(['browse', 'create', 'join'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 9,
                border: `1px solid ${tab === t ? '#7cffcb' : 'rgba(124,255,203,0.22)'}`,
                background: tab === t ? 'rgba(124,255,203,0.16)' : 'rgba(6,24,18,0.6)',
                color: tab === t ? '#d1fae5' : 'rgba(203,213,225,0.85)',
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontWeight: 700,
                fontSize: 12,
                letterSpacing: '0.08em',
                cursor: 'pointer',
                textTransform: 'uppercase',
              }}
            >
              {t === 'browse' ? 'Browse' : t === 'create' ? 'Create' : 'Join Code'}
            </button>
          ))}
        </div>

        {tab === 'browse' && <BrowseTab isMobile={isMobile} router={router} onClose={onClose} />}
        {tab === 'create' && <CreateTab isMobile={isMobile} router={router} onClose={onClose} />}
        {tab === 'join' && <JoinTab isMobile={isMobile} router={router} onClose={onClose} />}
      </div>
    </div>
  );
}

// ─── Browse tab — public open tables list + Join (sit) ──────────────────────────

function BrowseTab({
  isMobile,
  router,
  onClose,
}: {
  isMobile: boolean;
  router: ReturnType<typeof useRouter>;
  onClose: () => void;
}) {
  const [tables, setTables] = useState<CashTableListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Poll the public list every LIST_POLL_MS while this tab is mounted.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await cashPokerApi.listTables(50);
        if (!cancelled) {
          setTables(res.tables);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(describeCashPokerError(err));
      }
      if (!cancelled) timer = setTimeout(tick, LIST_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleJoin = useCallback(
    async (t: CashTableListItem) => {
      setBusyId(t.id);
      setError(null);
      try {
        // Public table → sit directly with the table's fixed buy-in.
        await cashPokerApi.sit(t.id, Number(t.buyInCt));
        onClose();
        router.push(`/cove/poker/cash/${t.id}`);
      } catch (err) {
        setError(describeCashPokerError(err));
        setBusyId(null);
      }
    },
    [router, onClose],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error && <ErrorLine>{error}</ErrorLine>}

      {tables == null ? (
        <Muted>Loading open tables…</Muted>
      ) : tables.length === 0 ? (
        <Muted>No public tables open right now — create one from the Create tab.</Muted>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tables.map((t) => {
            const full = t.occupiedSeats >= t.maxSeats;
            const busy = busyId === t.id;
            const tierLabel =
              t.tierKey && CASH_TIERS[t.tierKey as CashTierKey]
                ? CASH_TIERS[t.tierKey as CashTierKey].label
                : 'Custom';
            return (
              <RuneFrame key={t.id} tier="rare" glow={false} style={{ padding: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: isMobile ? 'wrap' : 'nowrap',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        color: '#f0fdf4',
                        fontFamily: 'ui-monospace, monospace',
                        fontWeight: 700,
                        fontSize: 14,
                      }}
                    >
                      {tierLabel} · {Number(t.smallBlindCt)}/{Number(t.bigBlindCt)}
                    </div>
                    <div style={{ color: 'rgba(148,184,170,0.85)', fontSize: 12, marginTop: 2 }}>
                      Buy-in {Number(t.buyInCt).toLocaleString()} vCLAW · {t.occupiedSeats}/{t.maxSeats}{' '}
                      seated
                    </div>
                  </div>
                  <RpgButton
                    variant="primary"
                    size="md"
                    loading={busy}
                    disabled={full || busy}
                    onClick={() => handleJoin(t)}
                    style={{ minWidth: 96, minHeight: 44 }}
                  >
                    {full ? 'Full' : `Sit · ${Number(t.buyInCt).toLocaleString()}`}
                  </RpgButton>
                </div>
              </RuneFrame>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Create tab — public tier OR private custom stakes ──────────────────────────

function CreateTab({
  isMobile,
  router,
  onClose,
}: {
  isMobile: boolean;
  router: ReturnType<typeof useRouter>;
  onClose: () => void;
}) {
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [tierKey, setTierKey] = useState<CashTierKey>('mid');
  const [maxSeats, setMaxSeats] = useState(6);
  const [seededAgentSlots, setSeededAgentSlots] = useState(0);
  // Private custom stakes.
  const [buyInCt, setBuyInCt] = useState(100);
  const [smallBlindCt, setSmallBlindCt] = useState(5);
  const [bigBlindCt, setBigBlindCt] = useState(10);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // After a private create: show the join code + a route-to-table button.
  const [created, setCreated] = useState<{ tableId: string; joinCode: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const body: CreateTableBody =
        visibility === 'private'
          ? {
              source: 'private',
              buyInCt,
              smallBlindCt,
              bigBlindCt,
              maxSeats,
              seededAgentSlots,
            }
          : {
              // Player-public tables run the Mid tier per the route's tiering;
              // we still pass the chosen tier (low/mid/high) for house-tier rooms.
              source: 'player-public',
              tierKey,
              maxSeats,
              seededAgentSlots,
            };
      const res = await cashPokerApi.createTable(body);
      const { id, joinCode, visibility: vis } = res.table;
      if (vis === 'private') {
        // Show the join code so the host can share it; route on their confirm.
        setCreated({ tableId: id, joinCode });
        setBusy(false);
      } else {
        // Public table — sit immediately + route to the felt.
        await cashPokerApi.sit(id, Number(res.table.buyInCt));
        onClose();
        router.push(`/cove/poker/cash/${id}`);
      }
    } catch (err) {
      setError(describeCashPokerError(err));
      setBusy(false);
    }
  }, [
    visibility,
    tierKey,
    maxSeats,
    seededAgentSlots,
    buyInCt,
    smallBlindCt,
    bigBlindCt,
    router,
    onClose,
  ]);

  const handleEnterCreated = useCallback(async () => {
    if (!created) return;
    setBusy(true);
    setError(null);
    try {
      // The host already holds the table's UUID; sit by joining their own code
      // (the route gates private /sit behind the code — join-by-code is the in).
      if (created.joinCode) {
        await cashPokerApi.joinByCode(created.joinCode);
      }
      onClose();
      router.push(`/cove/poker/cash/${created.tableId}`);
    } catch (err) {
      setError(describeCashPokerError(err));
      setBusy(false);
    }
  }, [created, router, onClose]);

  const copyCode = useCallback(() => {
    if (!created?.joinCode) return;
    try {
      void navigator.clipboard.writeText(created.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — code is still visible to copy manually */
    }
  }, [created]);

  // Post-create private success state.
  if (created) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
        <div style={{ color: '#d1fae5', fontSize: 13, textAlign: 'center' }}>
          Private table created. Share this code with friends so they can join:
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid rgba(124,255,203,0.4)',
            borderRadius: 10,
            padding: '12px 18px',
          }}
        >
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: '0.2em',
              color: '#7cffcb',
            }}
          >
            {created.joinCode ?? '——————'}
          </span>
          <button
            type="button"
            onClick={copyCode}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid rgba(124,255,203,0.4)',
              background: 'rgba(124,255,203,0.1)',
              color: '#d1fae5',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        {error && <ErrorLine>{error}</ErrorLine>}
        <RpgButton
          variant="primary"
          size="lg"
          loading={busy}
          onClick={handleEnterCreated}
          style={{ minWidth: 220 }}
        >
          Take my seat
        </RpgButton>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Visibility toggle */}
      <Field label="Visibility">
        <div style={{ display: 'flex', gap: 8 }}>
          {(['public', 'private'] as const).map((v) => (
            <ChoiceChip
              key={v}
              active={visibility === v}
              onClick={() => setVisibility(v)}
              label={v === 'public' ? 'Public (open list)' : 'Private (invite code)'}
            />
          ))}
        </div>
      </Field>

      {/* Public → tier picker; private → custom stakes */}
      {visibility === 'public' ? (
        <Field label="Stakes tier">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(Object.keys(CASH_TIERS) as CashTierKey[]).map((k) => {
              const tier = CASH_TIERS[k];
              return (
                <ChoiceChip
                  key={k}
                  active={tierKey === k}
                  onClick={() => setTierKey(k)}
                  label={`${tier.label} · ${tier.smallBlindCt}/${tier.bigBlindCt} · ${tier.buyInCt} vCLAW`}
                />
              );
            })}
          </div>
        </Field>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: 10 }}>
          <NumberField label="Buy-in (vCLAW)" value={buyInCt} min={1} onChange={setBuyInCt} />
          <NumberField label="Small blind" value={smallBlindCt} min={1} onChange={setSmallBlindCt} />
          <NumberField label="Big blind" value={bigBlindCt} min={1} onChange={setBigBlindCt} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <NumberField label="Max seats (2–8)" value={maxSeats} min={2} max={8} onChange={setMaxSeats} />
        <NumberField
          label="Seeded agents (0–seats)"
          value={seededAgentSlots}
          min={0}
          max={maxSeats}
          onChange={setSeededAgentSlots}
        />
      </div>

      {visibility === 'private' && bigBlindCt < smallBlindCt && (
        <ErrorLine>Big blind must be ≥ small blind.</ErrorLine>
      )}
      {visibility === 'private' && buyInCt < bigBlindCt && (
        <ErrorLine>Buy-in must cover at least one big blind.</ErrorLine>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}

      <RpgButton
        variant="primary"
        size="lg"
        loading={busy}
        disabled={
          busy ||
          (visibility === 'private' &&
            (bigBlindCt < smallBlindCt || buyInCt < bigBlindCt || buyInCt < 1))
        }
        onClick={handleCreate}
        style={{ minWidth: 220 }}
      >
        {visibility === 'private' ? 'Create private room' : 'Create & sit'}
      </RpgButton>
    </div>
  );
}

// ─── Join tab — paste a code ────────────────────────────────────────────────────

function JoinTab({
  isMobile,
  router,
  onClose,
}: {
  isMobile: boolean;
  router: ReturnType<typeof useRouter>;
  onClose: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleJoin = useCallback(async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await cashPokerApi.joinByCode(trimmed);
      onClose();
      router.push(`/cove/poker/cash/${res.tableId}`);
    } catch (err) {
      setError(describeCashPokerError(err));
      setBusy(false);
    }
  }, [code, router, onClose]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
      <div style={{ color: 'rgba(203,213,225,0.85)', fontSize: 13, textAlign: 'center' }}>
        Enter the join code a friend shared to take a seat at their private table.
      </div>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleJoin();
        }}
        placeholder="ABC123"
        maxLength={16}
        aria-label="Join code"
        style={{
          width: isMobile ? '100%' : 240,
          textAlign: 'center',
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(124,255,203,0.4)',
          borderRadius: 10,
          color: '#7cffcb',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: '0.22em',
          padding: '12px 14px',
        }}
      />
      {error && <ErrorLine>{error}</ErrorLine>}
      <RpgButton
        variant="primary"
        size="lg"
        loading={busy}
        disabled={busy || !code.trim()}
        onClick={handleJoin}
        style={{ minWidth: 220 }}
      >
        Join table
      </RpgButton>
    </div>
  );
}

// ─── Small shared bits (light-on-dark tokens only) ──────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'rgba(148,184,170,0.85)',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Math.floor(Number(e.target.value));
          if (Number.isNaN(n)) {
            onChange(min);
            return;
          }
          let clamped = Math.max(min, n);
          if (max != null) clamped = Math.min(max, clamped);
          onChange(clamped);
        }}
        style={{
          width: '100%',
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(124,255,203,0.3)',
          borderRadius: 8,
          color: '#f0fdf4',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 15,
          fontWeight: 700,
          padding: '9px 10px',
          textAlign: 'right',
        }}
      />
    </Field>
  );
}

function ChoiceChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '8px 12px',
        borderRadius: 8,
        border: `1px solid ${active ? '#7cffcb' : 'rgba(124,255,203,0.25)'}`,
        background: active ? 'rgba(124,255,203,0.16)' : 'rgba(6,24,18,0.6)',
        color: active ? '#d1fae5' : 'rgba(203,213,225,0.85)',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        color: '#fca5a5',
        fontSize: 12,
        textAlign: 'center',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: 'rgba(148,184,170,0.85)',
        fontSize: 13,
        textAlign: 'center',
        padding: '20px 8px',
      }}
    >
      {children}
    </div>
  );
}
