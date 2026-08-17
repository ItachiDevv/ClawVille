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
  type DeferredWarmResultKind,
} from '@/lib/three/deferred-warm';

type DeferredWarmAttachmentProps = {
  children: ReactNode | ((ready: boolean) => ReactNode);
  label: string;
  priority?: number;
  /**
   * Slice D (§3): rendered as a SIBLING outside the hidden group while
   * `!ready` — the commit that flips `ready` unmounts the placeholder and
   * reveals the warmed subtree in the same commit (atomic on the success
   * path). On warm FAIL-OPEN the real content still appears (may hitch
   * once — pre-existing product behavior); `onWarmResult` reports which.
   */
  placeholder?: ReactNode;
  /** Reports the warm outcome once: 'warmed' (upload+compile completed) or
   * 'failopen' (any fail-open leg). Measurement runs reject 'failopen'
   * [R2-F11]; product behavior is unchanged. */
  onWarmResult?: (kind: DeferredWarmResultKind) => void;
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
  placeholder,
  onWarmResult,
}: DeferredWarmAttachmentProps) {
  const rootRef = useRef<THREE.Group>(null);
  const [ready, setReady] = useState(false);
  const { gl, camera, scene } = useThree();
  const onWarmResultRef = useRef(onWarmResult);
  onWarmResultRef.current = onWarmResult;

  useEffect(() => {
    const object = rootRef.current;
    if (!object) return undefined;

    let resultKind: DeferredWarmResultKind = 'failopen';
    return enqueueDeferredWarm({
      priority,
      warm: async (isCancelled) => {
        resultKind = await warmDeferredObject({
          renderer: gl as unknown as DeferredWarmRenderer,
          scene,
          camera,
          object,
          isCancelled,
          label,
        });
      },
      onStateChange: (state) => {
        if (state === 'ready') {
          setReady(true);
          try {
            onWarmResultRef.current?.(resultKind);
          } catch (error) {
            console.warn(`[DeferredWarm] ${label}: onWarmResult threw:`, error);
          }
        }
      },
      onError: (error) => {
        console.warn(`[DeferredWarm] ${label}: warm job failed open:`, error);
      },
    });
  }, [camera, gl, label, priority, scene]);

  return (
    <>
      {!ready && placeholder}
      <group ref={rootRef} visible={ready}>
        {typeof children === 'function' ? children(ready) : children}
      </group>
    </>
  );
}
