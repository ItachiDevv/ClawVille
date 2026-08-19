'use client';

/**
 * boot-streamed-content.tsx — shared slice-D stream wrapper for non-building
 * consumers (town props, town NPCs). Spec §3/§4c (FROZEN rev 5): gate →
 * boundary → Suspense → DeferredWarmAttachment → suspending child, with
 * cohort accounting at every transition. No placeholder (props/NPCs pop in
 * warmed, like the slice-C ambient bodies); buildings have their own proxy
 * wrapper in arena-buildings.tsx.
 */

import { Component, Suspense, useEffect, type ReactNode } from 'react';
import { DeferredWarmAttachment } from '@/lib/three/deferred-warm-attachment';
import { reportCohortState } from '@/lib/three/boot-stream-cohort';
import { useBootStreamRelease } from '@/lib/three/use-boot-stream-release';

/** Load-rejection containment [F11] — a failed GLB/VRM reports `failed`
 * (terminal) and renders nothing; the world tree survives. */
class StreamBoundary extends Component<
  { onFailed: () => void; children: ReactNode },
  { errored: boolean }
> {
  constructor(props: { onFailed: () => void; children: ReactNode }) {
    super(props);
    this.state = { errored: false };
  }
  static getDerivedStateFromError(): { errored: boolean } {
    return { errored: true };
  }
  componentDidCatch(error: unknown): void {
    console.warn('[boot-stream] streamed content failed; dropped:', error);
    this.props.onFailed();
  }
  render() {
    return this.state.errored ? null : this.props.children;
  }
}

function CohortCommitProbe({ cohortId }: { cohortId: string }) {
  useEffect(() => {
    reportCohortState(cohortId, 'warm-pending');
  }, [cohortId]);
  return null;
}

/**
 * Children may be a render-prop `(ready) => node` (to thread
 * `attachmentVisible` into DOM labels) or plain nodes.
 */
export function BootStreamedContent({
  cohortId,
  priority,
  children,
}: {
  cohortId: string;
  priority: number;
  children: ReactNode | ((ready: boolean) => ReactNode);
}) {
  const released = useBootStreamRelease(priority, cohortId);

  useEffect(() => {
    reportCohortState(cohortId, 'mounted');
  }, [cohortId]);
  useEffect(() => {
    if (released) reportCohortState(cohortId, 'loading');
  }, [released, cohortId]);

  if (!released) return null;
  return (
    <StreamBoundary onFailed={() => reportCohortState(cohortId, 'failed')}>
      <Suspense fallback={null}>
        <DeferredWarmAttachment
          label={cohortId}
          priority={priority}
          onWarmResult={(kind) =>
            reportCohortState(
              cohortId,
              kind === 'warmed' ? 'ready-warmed' : 'ready-failopen',
            )
          }
        >
          {(ready) => (
            <>
              <CohortCommitProbe cohortId={cohortId} />
              {typeof children === 'function' ? children(ready) : children}
            </>
          )}
        </DeferredWarmAttachment>
      </Suspense>
    </StreamBoundary>
  );
}
