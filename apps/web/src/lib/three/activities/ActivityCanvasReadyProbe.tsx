'use client';

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

export interface ActivityCanvasReadyState {
  frames: number;
  fired: boolean;
}

export function advanceActivityCanvasReady(
  state: ActivityCanvasReadyState,
  scheduleAck: () => void,
): void {
  if (state.fired) return;
  state.frames += 1;
  if (state.frames < 2) return;
  state.fired = true;
  scheduleAck();
}

export function activityCanvasDrawCalls(gl: unknown): number | undefined {
  return (
    gl as {
      info?: { render?: { calls?: number } };
    }
  ).info?.render?.calls;
}

export function ActivityCanvasReadyProbe(props: {
  readonly roomKey: string;
  readonly onPainted: (roomKey: string) => void;
  readonly onCanvas: (element: HTMLCanvasElement | null) => void;
}): null {
  const readinessRef = useRef<ActivityCanvasReadyState>({
    frames: 0,
    fired: false,
  });
  const { gl } = useThree();
  const { onCanvas, onPainted, roomKey } = props;

  useEffect(() => {
    onCanvas(gl.domElement);
    return () => onCanvas(null);
  }, [gl, onCanvas]);

  useFrame(() => {
    advanceActivityCanvasReady(readinessRef.current, () => {
      queueMicrotask(() => {
      if (process.env.NODE_ENV !== 'production') {
        const calls = activityCanvasDrawCalls(gl);
        if (!(typeof calls === 'number' && calls > 0)) {
          console.error('[activity] canvas readiness acked without a draw');
        }
      }
      onPainted(roomKey);
      });
    });
  });

  return null;
}
