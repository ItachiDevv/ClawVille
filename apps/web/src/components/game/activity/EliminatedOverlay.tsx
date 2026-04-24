'use client';

/**
 * EliminatedOverlay — full spectator UX shown after a player is KO'd
 * mid-match. Spec: frontend-spec.md §7.
 *
 * Chunk #11 upgrades the chunk #4 stub from a static "ELIMINATED"
 * placard into a working spectator surface:
 *   - Dimmed overlay (does NOT block 3D viewport pointer events outside
 *     the side panel, so the user can still see the action)
 *   - Top header: "ELIMINATED — {remainingSec}s remaining"
 *   - Right-side spectator panel:
 *      - Spectating row with prev/next + free-cam selector
 *      - Mini-leaderboard (live)
 *      - Spectator chat channel (separate from active-player chat)
 *      - Cheer / Taunt emote buttons (15s rate-limit per emote)
 *
 * Camera caveat (see SpectatorCamSelector.tsx) — the cam mode is captured
 * locally + emitted via `onCamModeChange`, but the underlying scene keeps
 * its static OrthographicCamera at this chunk to preserve the Iris Xe
 * perf invariant. Camera motion ships in a 3da-paired follow-up.
 *
 * State management: the overlay holds NO match state — all reads come
 * from props provided by `bumper-shells-hud.tsx`. This keeps it testable
 * in isolation and prevents a second store subscription path.
 */

import { useMemo } from 'react';
import HudMiniLeaderboard from './HudMiniLeaderboard';
import SpectatorCamSelector, { type SpectatorCamMode } from './SpectatorCamSelector';
import SpectatorChatPanel from './SpectatorChatPanel';
import EmoteButton from './EmoteButton';
import type { ActivityChatMessage, ActivityScoreEntry } from '@/stores/activity';
import type { BumperShellEntity } from '@/lib/three/activities/bumper-shells/bumper-shells-types';

// ─── Public API ──────────────────────────────────────────────────────────────

export interface EliminatedOverlayProps {
  /** Wall-clock millis the elimination happened (Date.now()). */
  eliminatedAt: number;
  /** Final/current placement of self (1-indexed). */
  placement: number | null;
  /** Self pet id — used for leaderboard self-row + chat self-tint. */
  selfPetId: string | null;
  /** Live leaderboard rows (top N + self). */
  leaderboard: ActivityScoreEntry[];
  /** Score map for `resolveName` lookups in the chat transcript. */
  scoreLookup: Map<string, ActivityScoreEntry>;
  /** Alive entities in stable order — for prev/next focus cycling. */
  aliveEntities: BumperShellEntity[];
  /** Spectator-channel chat history. */
  spectatorChat: ActivityChatMessage[];
  /** Server-driven round end time; null/undef → header omits the timer. */
  roundEndsAt?: number | null;
  /** Currently focused pet id (controlled by parent). */
  spectatorTargetPetId: string | null;
  /** Local cam-mode pick. */
  spectatorCamMode: SpectatorCamMode;
  /** Cooldown sentinel for cheer button (wall-clock millis or null). */
  cheerCooldownUntil: number | null;
  /** Cooldown sentinel for taunt button. */
  tauntCooldownUntil: number | null;
  /** Cooldown window in ms — exposed so the ring matches the rate-limit. */
  emoteCooldownMs: number;

  // ── Callbacks (parent owns intent + WS sends) ──────────────────────────
  onSelectPrev: () => void;
  onSelectNext: () => void;
  onSelectFree: () => void;
  onCamModeChange: (next: SpectatorCamMode) => void;
  /** Returns true if the chat send succeeded (parent dispatches WS). */
  onSendChat: (text: string) => boolean;
  onCheer: () => void;
  onTaunt: () => void;
  /**
   * Backwards-compat (chunk #4 callers): the chunk #4 stub accepted only
   * `eliminatedAt`, `placement`, `spectatingPet`. Tests + legacy callers
   * passing the old shape still compile but get the upgraded UI when the
   * new props are also supplied. The field is read-only in §7's wireframe.
   */
  spectatingPet?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EliminatedOverlay(props: EliminatedOverlayProps) {
  const {
    eliminatedAt,
    placement,
    selfPetId,
    leaderboard,
    scoreLookup,
    aliveEntities,
    spectatorChat,
    roundEndsAt,
    spectatorTargetPetId,
    spectatorCamMode,
    cheerCooldownUntil,
    tauntCooldownUntil,
    emoteCooldownMs,
    onSelectPrev,
    onSelectNext,
    onSelectFree,
    onCamModeChange,
    onSendChat,
    onCheer,
    onTaunt,
  } = props;

  // Derive the spectated-pet display name for the header row.
  const spectatedName = useMemo(() => {
    if (spectatorCamMode === 'free') return 'Free Camera';
    if (spectatorCamMode === 'action') return 'Action Cam';
    if (!spectatorTargetPetId) return 'Pick a target';
    return resolveDisplayName(spectatorTargetPetId, scoreLookup, aliveEntities);
  }, [spectatorCamMode, spectatorTargetPetId, scoreLookup, aliveEntities]);

  const remainingSec = roundEndsAt
    ? Math.max(0, Math.round((roundEndsAt - Date.now()) / 1000))
    : null;

  const sinceElim = Math.max(0, Math.floor((Date.now() - eliminatedAt) / 1000));

  // Resolver for chat names — falls back to short petId tail.
  const resolveName = (petId: string) => resolveDisplayName(petId, scoreLookup, aliveEntities);

  // Disable prev/next when there are no other alive players to switch to.
  const canCycle = aliveEntities.length > 0;

  return (
    <>
      {/*
       * Backdrop — covers the viewport with a soft grayscale dim. Pointer
       * events are intentionally ALLOWED through the backdrop (transparent
       * to clicks) so the user can still interact with the world; only
       * the side panel + top header capture pointer input.
       */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(ellipse at center, rgba(11, 18, 32, 0.45) 0%, rgba(11, 18, 32, 0.78) 100%)',
          backdropFilter: 'grayscale(40%) brightness(0.78)',
          WebkitBackdropFilter: 'grayscale(40%) brightness(0.78)',
          pointerEvents: 'none',
          zIndex: 25,
        }}
        role="status"
        aria-live="polite"
      />

      {/* Top-center ELIMINATED header */}
      <div
        style={{
          position: 'absolute',
          top: 56,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          pointerEvents: 'none',
          zIndex: 26,
        }}
      >
        <div
          className="claw-panel"
          style={{
            padding: '14px 28px',
            textAlign: 'center',
            borderColor: 'rgba(255, 82, 82, 0.55)',
            boxShadow: '0 0 24px rgba(255, 82, 82, 0.32)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 28,
              fontWeight: 900,
              letterSpacing: '0.16em',
              color: '#fca5a5',
              textShadow: '0 0 16px rgba(255, 82, 82, 0.6)',
              lineHeight: 1,
            }}
          >
            ELIMINATED
          </span>
          {remainingSec !== null ? (
            <span
              style={{
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 11,
                color: 'rgba(226, 232, 240, 0.85)',
                letterSpacing: '0.18em',
              }}
            >
              {remainingSec}s remaining in round
            </span>
          ) : (
            <span
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 10,
                color: 'rgba(148, 163, 184, 0.75)',
                letterSpacing: '0.1em',
              }}
            >
              KO'd {sinceElim}s ago
            </span>
          )}
          {placement !== null && (
            <span
              style={{
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 10,
                color: '#facc15',
                letterSpacing: '0.18em',
                marginTop: 2,
              }}
            >
              CURRENT PLACEMENT · #{placement}
            </span>
          )}
        </div>
      </div>

      {/* Right-side spectator panel */}
      <aside
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          bottom: 12,
          width: 320,
          maxWidth: 'calc(100vw - 24px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          pointerEvents: 'none',
          zIndex: 27,
        }}
        aria-label="Spectator controls"
      >
        {/*
         * Spectating-target panel — prev/next cycler + cam selector.
         * pointer-events:auto on the inner container so the buttons work
         * while the surrounding aside stays click-through.
         */}
        <div
          className="claw-panel"
          style={{
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            pointerEvents: 'auto',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 9,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: 'rgba(0, 229, 255, 0.7)',
                fontWeight: 700,
              }}
            >
              Spectating
            </span>
            <span
              style={{
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 12,
                fontWeight: 700,
                color: '#e0f7ff',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 160,
              }}
            >
              {spectatedName}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <CycleButton
              label="◀ Prev"
              onClick={onSelectPrev}
              disabled={!canCycle}
              ariaLabel="Previous spectated player"
            />
            <CycleButton
              label="Free Cam"
              onClick={onSelectFree}
              disabled={spectatorCamMode === 'free'}
              ariaLabel="Switch to free camera"
            />
            <CycleButton
              label="Next ▶"
              onClick={onSelectNext}
              disabled={!canCycle}
              ariaLabel="Next spectated player"
            />
          </div>
          <SpectatorCamSelector mode={spectatorCamMode} onChange={onCamModeChange} />
        </div>

        {/* Live leaderboard — reuses the active-match HudMiniLeaderboard */}
        <div style={{ pointerEvents: 'auto' }}>
          <HudMiniLeaderboard entries={leaderboard} selfId={selfPetId} max={5} />
        </div>

        {/* Spectator chat channel */}
        <div
          className="claw-panel"
          style={{
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            flex: 1,
            minHeight: 220,
            pointerEvents: 'auto',
          }}
        >
          <SpectatorChatPanel
            messages={spectatorChat}
            resolveName={resolveName}
            selfPetId={selfPetId}
            onSend={onSendChat}
            maxHeight={180}
          />
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: 4,
              borderTop: '1px dashed rgba(0, 229, 255, 0.2)',
            }}
          >
            <EmoteButton
              glyph="👏"
              label="Cheer"
              tone="positive"
              cooldownUntil={cheerCooldownUntil}
              cooldownMs={emoteCooldownMs}
              onClick={onCheer}
              ariaLabel="Send cheer emote (rate limited 1 per 15s)"
            />
            <EmoteButton
              glyph="😈"
              label="Taunt"
              tone="danger"
              cooldownUntil={tauntCooldownUntil}
              cooldownMs={emoteCooldownMs}
              onClick={onTaunt}
              ariaLabel="Send taunt emote (rate limited 1 per 15s)"
            />
          </div>
        </div>
      </aside>
    </>
  );
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function CycleButton({
  label,
  onClick,
  disabled,
  ariaLabel,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      data-hud-interactive="true"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        flex: 1,
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(0, 229, 255, 0.4)',
        background: disabled
          ? 'rgba(15, 31, 58, 0.55)'
          : 'linear-gradient(180deg, rgba(15, 31, 58, 0.95), rgba(6, 13, 23, 0.95))',
        color: disabled ? 'rgba(148, 163, 184, 0.55)' : '#e0f7ff',
        fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        cursor: disabled ? 'not-allowed' : 'pointer',
        pointerEvents: 'auto',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

function resolveDisplayName(
  petId: string,
  scoreLookup: Map<string, ActivityScoreEntry>,
  aliveEntities: BumperShellEntity[],
): string {
  const score = scoreLookup.get(petId);
  if (score?.displayName) return score.displayName;
  const ent = aliveEntities.find((e) => e.petId === petId);
  if (ent) return shortPetId(petId);
  return shortPetId(petId);
}

function shortPetId(petId: string): string {
  return petId.length > 8 ? `…${petId.slice(-6)}` : petId;
}
