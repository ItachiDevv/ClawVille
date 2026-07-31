'use client';

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

export function ActivityCanvasReadyProbe(props: {
  readonly roomKey: string;
  readonly onPainted: (roomKey: string) => void;
  readonly onCanvas: (element: HTMLCanvasElement | null) => void;
}): null {
  const framesRef = useRef(0);
  const firedRef = useRef(false);
  const { gl } = useThree();
  const { onCanvas, onPainted, roomKey } = props;

  useEffect(() => {
    onCanvas(gl.domElement);
    return () => onCanvas(null);
  }, [gl, onCanvas]);

  useFrame(() => {
    if (firedRef.current) return;
    framesRef.current += 1;
    if (framesRef.current < 2) return;
    firedRef.current = true;
    queueMicrotask(() => {
      if (process.env.NODE_ENV !== 'production') {
        const calls = (
          gl as unknown as {
            info?: { render?: { calls?: number } };
          }
        ).info?.render?.calls;
        if (!(typeof calls === 'number' && calls > 0)) {
          console.error('[activity] canvas readiness acked without a draw');
        }
      }
      onPainted(roomKey);
    });
  });

  return null;
}
