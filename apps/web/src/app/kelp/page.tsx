'use client';

import {
  Component,
  useCallback,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import dynamic from 'next/dynamic';
import SceneTransition, { useSceneTransition } from '@/components/transitions/SceneTransition';
import { avatarPositionRef, useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import KelpRealmMobileControls from '@/components/kelp/KelpRealmMobileControls';
import { KelpRealmClaimHud } from '@/components/kelp/KelpRealmClaimHud';
import { MAP_HEIGHT, MAP_WIDTH } from '@/lib/pixi/tilemap-data';
import { KELP_FOREST_EXIT_WORLD } from '@/lib/three/kelp-forest-location';
import {
  getKelpRealmRendererFailure,
  getKelpRealmRendererFailureServerSnapshot,
  subscribeKelpRealmRendererFailure,
} from '@/lib/three/kelp-realm-renderer-status';

const KELP_EXIT_PX = Object.freeze({
  x: MAP_WIDTH / 2 + KELP_FOREST_EXIT_WORLD.x,
  y: MAP_HEIGHT / 2 + KELP_FOREST_EXIT_WORLD.z,
});

function KelpRealmLoading() {
  return (
    <div
      aria-live="polite"
      aria-label="Entering the Kelp Forest"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: '#0d4552',
        color: '#70ffe2',
        font: '700 15px monospace',
      }}
    >
      <span className="kelp-realm-loading-spinner" aria-hidden="true" />
      <span>Entering the Kelp Forest…</span>
      <style>{`
        @keyframes kelp-realm-loading-spin {
          to { transform: rotate(360deg); }
        }
        .kelp-realm-loading-spinner {
          width: 24px;
          height: 24px;
          border: 2px solid rgba(112, 255, 226, 0.25);
          border-top-color: #70ffe2;
          border-radius: 999px;
          animation: kelp-realm-loading-spin 0.85s linear infinite;
        }
      `}</style>
    </div>
  );
}

function KelpRealmChunkFailure() {
  return (
    <div
      role="alert"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: '#0d4552',
      }}
    >
      <div style={{ maxWidth: 440, textAlign: 'center' }}>
        <p style={{ margin: '0 0 18px', color: '#c7fff4', font: '700 17px monospace' }}>
          The kelp forest couldn&apos;t load.
        </p>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{
            padding: '10px 18px',
            border: '1px solid rgba(112,255,226,0.65)',
            borderRadius: 10,
            background: 'rgba(1,18,17,0.88)',
            color: '#70ffe2',
            font: '700 14px monospace',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}

class KelpRealmCanvasErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error('[KelpRealm] canvas subtree crashed:', error, info.componentStack ?? '');
  }

  render() {
    return this.state.failed ? <KelpRealmChunkFailure /> : this.props.children;
  }
}

const KelpRealmCanvas = dynamic(() => import('@/components/three/KelpRealmCanvas').catch((err: unknown) => {
  console.error('[KelpRealm] canvas chunk failed to load:', err);
  void import('@/lib/three/kelp-render-failure-beacon')
    .then(({ reportKelpRenderFailure, describeErrorForBeacon }) =>
      reportKelpRenderFailure('chunk-load-failed', describeErrorForBeacon(err)))
    .catch(() => undefined);
  throw err;
}), {
  ssr: false,
  loading: KelpRealmLoading,
});

export default function KelpPage() {
  const { triggerTransition } = useSceneTransition();
  const { data: avatar } = useAvatar();
  const rendererFailure = useSyncExternalStore(
    subscribeKelpRealmRendererFailure,
    getKelpRealmRendererFailure,
    getKelpRealmRendererFailureServerSnapshot,
  );
  useEffect(() => {
    if (!avatar) return;
    useGameStore.getState().setAvatarAppearance(avatar.species, avatar.color, undefined, avatar.modelKey);
  }, [avatar]);
  const handleBack = useCallback(() => {
    triggerTransition({
      to: '/game',
      onMidway: () => {
        avatarPositionRef.x = KELP_EXIT_PX.x;
        avatarPositionRef.y = KELP_EXIT_PX.y;
        useGameStore.getState().setAvatarPosition(KELP_EXIT_PX.x, KELP_EXIT_PX.y);
      },
    });
  }, [triggerTransition]);

  return (
    <main
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#0d4552', color: '#c7fff4', fontFamily: 'monospace' }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <KelpRealmCanvasErrorBoundary>
          <KelpRealmCanvas />
        </KelpRealmCanvasErrorBoundary>
      </div>
      <SceneTransition fadeInOnMount />
      <button
        type="button"
        onClick={handleBack}
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 50,
          padding: '10px 18px',
          border: '1px solid rgba(72,255,222,0.5)',
          borderRadius: 10,
          background: 'rgba(1,18,17,0.82)',
          color: '#70ffe2',
          font: '700 14px monospace',
          cursor: 'pointer',
        }}
      >
        Back to the Reef
      </button>
      {rendererFailure ? (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: '#0d4552',
          }}
        >
          <div style={{ maxWidth: 560, textAlign: 'center' }}>
            <p style={{ margin: '0 0 18px', color: '#c7fff4', font: '700 17px/1.55 monospace' }}>
              This browser couldn&apos;t start the 3D view. Try updating your browser or enabling hardware acceleration.
            </p>
            <button
              type="button"
              onClick={handleBack}
              style={{
                padding: '10px 18px',
                border: '1px solid rgba(112,255,226,0.65)',
                borderRadius: 10,
                background: 'rgba(1,18,17,0.88)',
                color: '#70ffe2',
                font: '700 14px monospace',
                cursor: 'pointer',
              }}
            >
              Back to the Reef
            </button>
          </div>
        </div>
      ) : null}
      <KelpRealmClaimHud />
      <KelpRealmMobileControls />
    </main>
  );
}
