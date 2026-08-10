'use client';

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import {
  enqueueDeferredWarm,
  warmDeferredObject,
  type DeferredWarmRenderer,
} from '@/lib/three/deferred-warm';

type DeferredWarmAttachmentProps = {
  children: ReactNode | ((ready: boolean) => ReactNode);
  label: string;
  priority?: number;
};

/**
 * Commits a resolved Suspense subtree hidden, queues its GPU warm, and flips
 * it visible only after texture upload + compileAsync complete (or fail
 * open). The zero-scissor direct warm runs ONLY as the fallback when
 * compileAsync did not complete — see warmDeferredObject.
 */
export function DeferredWarmAttachment({
  children,
  label,
  priority = 0,
}: DeferredWarmAttachmentProps) {
  const rootRef = useRef<THREE.Group>(null);
  const [ready, setReady] = useState(false);
  const { gl, camera, scene } = useThree();

  useEffect(() => {
    const object = rootRef.current;
    if (!object) return undefined;

    return enqueueDeferredWarm({
      priority,
      warm: (isCancelled) =>
        warmDeferredObject({
          renderer: gl as unknown as DeferredWarmRenderer,
          scene,
          camera,
          object,
          isCancelled,
          label,
        }),
      onStateChange: (state) => {
        if (state === 'ready') setReady(true);
      },
      onError: (error) => {
        console.warn(`[DeferredWarm] ${label}: warm job failed open:`, error);
      },
    });
  }, [camera, gl, label, priority, scene]);

  return (
    <group ref={rootRef} visible={ready}>
      {typeof children === 'function' ? children(ready) : children}
    </group>
  );
}
