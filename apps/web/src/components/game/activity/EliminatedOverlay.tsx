'use client';

/**
 * EliminatedOverlay — full-viewport dim + "ELIMINATED — spectating" message
 * shown when self has been knocked off the arena. Spec: frontend-spec.md
 * §3.4 + §7 (spectator mode).
 */

export interface EliminatedOverlayProps {
  /** Wall-clock timestamp the elimination happened (Date.now()). */
  eliminatedAt: number;
  /** Final/current placement of self. */
  placement: number | null;
  /** Optional name of the player the camera is following (chunk #8). */
  spectatingPet?: string;
}

export default function EliminatedOverlay({
  eliminatedAt,
  placement,
  spectatingPet,
}: EliminatedOverlayProps) {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - eliminatedAt) / 1000));
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background:
          'radial-gradient(ellipse at center, rgba(11, 18, 32, 0.55) 0%, rgba(11, 18, 32, 0.85) 100%)',
        backdropFilter: 'grayscale(60%) brightness(0.7)',
        WebkitBackdropFilter: 'grayscale(60%) brightness(0.7)',
        pointerEvents: 'none',
        zIndex: 25,
      }}
      role="status"
      aria-live="polite"
    >
      <div
        className="claw-panel"
        style={{
          padding: '20px 32px',
          textAlign: 'center',
          borderColor: 'rgba(255, 82, 82, 0.55)',
          boxShadow: '0 0 28px rgba(255, 82, 82, 0.32)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 36,
            fontWeight: 900,
            letterSpacing: '0.12em',
            color: '#fca5a5',
            textShadow: '0 0 16px rgba(255, 82, 82, 0.6)',
            marginBottom: 6,
          }}
        >
          ELIMINATED
        </div>
        {placement !== null && (
          <div
            style={{
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 14,
              color: '#facc15',
              letterSpacing: '0.16em',
              marginBottom: 10,
            }}
          >
            FINAL PLACEMENT · #{placement}
          </div>
        )}
        <div
          style={{
            fontSize: 12,
            color: 'rgba(226, 232, 240, 0.85)',
            marginBottom: 4,
          }}
        >
          {spectatingPet ? `Spectating ${spectatingPet}` : 'Spectating remaining shells…'}
        </div>
        <div
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 10,
            color: 'rgba(148, 163, 184, 0.75)',
            letterSpacing: '0.1em',
          }}
        >
          {elapsedSec}s ago
        </div>
      </div>
    </div>
  );
}
