'use client';

import { useEffect, useRef } from 'react';

export default function GameCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    let destroyed = false;

    (async () => {
      const Phaser = (await import('phaser')).default;
      const { getGameConfig } = await import('@/lib/phaser/game-config');

      if (destroyed || !containerRef.current) return;

      gameRef.current = new Phaser.Game(getGameConfig(containerRef.current));
    })();

    return () => {
      destroyed = true;
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      id="phaser-game"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
