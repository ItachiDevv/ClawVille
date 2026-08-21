'use client';

/**
 * boot-streamed-content.tsx — shared slice-D stream wrapper for non-building
 * consumers (town props, town NPCs). Spec §3/§4c (FROZEN rev 5): gate →
 * boundary → Suspense → DeferredWarmAttachment → suspending child, with
 * cohort accounting at every transition. No placeholder (props/NPCs pop in
 * warmed, like the slice-C ambient bodies); buildings have their own
 * wrapper in arena-buildings.tsx.
 *
 * BGR guide amendment (founder 2026-08-20): `revealRequired` runs the same
 * chain on the BOOT-CRITICAL stage-B lane with the full reveal-token ack
 * protocol (instance-paired commit + renderer-identity warm + durable
 * failed marker — mirrors StreamedGLBBuilding), so a member like Nori loads
 * BEHIND the SeaLoadingScreen and gates the reveal.
 */

import { Component, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { DeferredWarmAttachment } from '@/lib/three/deferred-warm-attachment';
import { reportCohortState } from '@/lib/three/boot-stream-cohort';
import {
  useBootBuildingsStreamRelease,
  useBootStreamRelease,
} from '@/lib/three/use-boot-stream-release';
import {
  ackBuildingCommit,
  ackBuildingFailed,
  ackBuildingWarm,
  declareBootGuideRevealRequired,
  resetBootGuideRevealRequired,
  revokeBuildingCommit,
  revokeBuildingInstance,
} from '@/lib/three/decorative-release';

/** Load-rejection containment [F11] — a failed GLB/VRM reports `failed`
 * (terminal) and renders nothing (plus the fallback probe on the
 * reveal-required path); the world tree survives. */
class StreamBoundary extends Component<
  { onFailed: () => void; fallback?: ReactNode; children: ReactNode },
  { errored: boolean }
> {
  constructor(props: { onFailed: () => void; fallback?: ReactNode; children: ReactNode }) {
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
    return this.state.errored ? (this.props.fallback ?? null) : this.props.children;
  }
}

function CohortCommitProbe({ cohortId }: { cohortId: string }) {
  useEffect(() => {
    reportCohortState(cohortId, 'warm-pending');
  }, [cohortId]);
  return null;
}

/** Reveal-token commit leg (mirrors BuildingCommitAckProbe — one instance
 * owner shared by every leg of this mount [fix-NF3]). */
function RevealCommitAckProbe({
  cohortId,
  owner,
  ready,
}: {
  cohortId: string;
  owner: symbol;
  ready: boolean;
}) {
  useEffect(() => {
    if (!ready) return undefined;
    ackBuildingCommit(cohortId, owner);
    return () => revokeBuildingCommit(cohortId, owner);
  }, [ready, cohortId, owner]);
  return null;
}

/** Durable failure marker (mirrors FailedBuildingAckProbe). */
function RevealFailedAckProbe({
  cohortId,
  owner,
}: {
  cohortId: string;
  owner: symbol;
}) {
  useEffect(() => {
    ackBuildingFailed(cohortId, owner);
  }, [cohortId, owner]);
  return null;
}

/**
 * BGR D6-style declaration for the guide requirement — mounted by
 * World3DCanvas (the one place that knows whether NPCs render this boot).
 * Owner-keyed, latest-wins, reset-on-unmount only while owning.
 */
export function DeclareGuideRevealRequired({ required }: { required: boolean }) {
  const ownerRef = useRef<symbol | null>(null);
  if (ownerRef.current === null) ownerRef.current = Symbol('guide-reveal');
  useEffect(() => {
    const owner = ownerRef.current!;
    declareBootGuideRevealRequired(required, owner);
    return () => resetBootGuideRevealRequired(owner);
  }, [required]);
  return null;
}

type BootStreamedContentProps = {
  cohortId: string;
  priority: number;
  /** BGR guide amendment: run on the boot-critical lane with the full
   * reveal-token ack protocol — this member then GATES the loading-screen
   * dismissal (pair with a DeclareGuideRevealRequired/mode declaration so
   * the requirement matches what actually mounts). */
  revealRequired?: boolean;
  children: ReactNode | ((ready: boolean) => ReactNode);
};

/** Post-reveal lane gate (the original slice-D path). Split into its own
 * component so each variant calls exactly one release hook. */
function PostRevealGate(props: BootStreamedContentProps) {
  const released = useBootStreamRelease(props.priority, props.cohortId);
  return <StreamedChain {...props} released={released} owner={null} />;
}

/** Boot-critical lane gate (reveal-required members — stage B). */
function BootCriticalGate(props: BootStreamedContentProps) {
  const released = useBootBuildingsStreamRelease(props.priority, props.cohortId);
  // ONE instance owner for ALL of this mount's ack legs [fix-NF3].
  const ownerRef = useRef<symbol | null>(null);
  if (ownerRef.current === null) ownerRef.current = Symbol(props.cohortId);
  return <StreamedChain {...props} released={released} owner={ownerRef.current} />;
}

function StreamedChain({
  cohortId,
  priority,
  released,
  owner,
  children,
}: BootStreamedContentProps & { released: boolean; owner: symbol | null }) {
  useEffect(() => {
    reportCohortState(cohortId, 'mounted');
    if (owner === null) return undefined;
    // The whole instance ack record dies with this mount — covers both the
    // success tree and the failed-boundary fallback.
    return () => revokeBuildingInstance(cohortId, owner);
  }, [cohortId, owner]);
  useEffect(() => {
    if (released) reportCohortState(cohortId, 'loading');
  }, [released, cohortId]);

  if (!released) return null;
  return (
    <StreamBoundary
      onFailed={() => reportCohortState(cohortId, 'failed')}
      fallback={
        owner !== null ? (
          <RevealFailedAckProbe cohortId={cohortId} owner={owner} />
        ) : null
      }
    >
      <Suspense fallback={null}>
        <DeferredWarmAttachment
          label={cohortId}
          priority={priority}
          onWarmResult={(kind, renderer) => {
            reportCohortState(
              cohortId,
              kind === 'warmed' ? 'ready-warmed' : 'ready-failopen',
            );
            if (owner !== null) {
              // Warm leg — renderer-identity, per-instance, additive
              // [impl-B4][fix-NF2/NF3].
              ackBuildingWarm(cohortId, owner, renderer);
            }
          }}
        >
          {(ready) => (
            <>
              <CohortCommitProbe cohortId={cohortId} />
              {owner !== null && (
                <RevealCommitAckProbe
                  cohortId={cohortId}
                  owner={owner}
                  ready={ready}
                />
              )}
              {typeof children === 'function' ? children(ready) : children}
            </>
          )}
        </DeferredWarmAttachment>
      </Suspense>
    </StreamBoundary>
  );
}

/**
 * Children may be a render-prop `(ready) => node` (to thread
 * `attachmentVisible` into DOM labels) or plain nodes.
 */
export function BootStreamedContent(props: BootStreamedContentProps) {
  // `revealRequired` is static per mount (a literal at every call site) —
  // the branch picks which release hook runs, each in its own component.
  return props.revealRequired ? (
    <BootCriticalGate {...props} />
  ) : (
    <PostRevealGate {...props} />
  );
}
