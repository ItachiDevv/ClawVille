'use client';

import { useCallback } from 'react';
import SceneTransition, { useSceneTransition } from '@/components/transitions/SceneTransition';
import { avatarPositionRef, useGameStore } from '@/stores/game';
import { MAP_HEIGHT, MAP_WIDTH } from '@/lib/pixi/tilemap-data';
import { KELP_FOREST_EXIT_WORLD } from '@/lib/three/kelp-forest-location';

const KELP_EXIT_PX = Object.freeze({
  x: MAP_WIDTH / 2 + KELP_FOREST_EXIT_WORLD.x,
  y: MAP_HEIGHT / 2 + KELP_FOREST_EXIT_WORLD.z,
});

export default function KelpRouteStub() {
  const { triggerTransition } = useSceneTransition();
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
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        background: 'radial-gradient(circle at 50% 35%, #0a4c49 0%, #032725 48%, #011211 100%)',
        color: '#c7fff4',
        fontFamily: 'monospace',
      }}
    >
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
      <div style={{ textAlign: 'center', padding: 24 }}>
        <h1 style={{ margin: 0, fontSize: 34 }}>Kelp Forest</h1>
        <p style={{ marginTop: 12, color: 'rgba(199,255,244,0.72)' }}>
          The current stirs. The grove opens in the next scene pass.
        </p>
      </div>
    </main>
  );
}
