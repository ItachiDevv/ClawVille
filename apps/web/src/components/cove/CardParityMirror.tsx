'use client';

import { useSyncExternalStore } from 'react';
import {
  getParitySnapshot,
  subscribeFeltParity,
  type Surface,
} from '@/lib/cove/card-parity-mirror';

export function ParityMirror({
  surface,
  instanceId,
}: {
  surface: Surface;
  instanceId: string;
}) {
  const snapshot = useSyncExternalStore(
    (callback) => subscribeFeltParity(surface, callback),
    () => getParitySnapshot(surface),
    () => getParitySnapshot(surface),
  );
  if (!snapshot || snapshot.instanceId !== instanceId) return null;

  const metaAttributes = Object.fromEntries(
    Object.entries(snapshot.meta).map(([key, value]) => [`data-${key}`, value]),
  );

  return (
    <ol
      {...metaAttributes}
      data-cv-parity={snapshot.surface}
      data-cv-parity-version="2"
      data-cv-render-revision={String(snapshot.renderRevision)}
      data-cv-correlation-hand={snapshot.correlation.hand}
      data-cv-hand-number={snapshot.correlation.handNumber == null
        ? ''
        : String(snapshot.correlation.handNumber)}
      data-cv-deal-step={snapshot.dealStep}
      data-cv-phase={snapshot.phase}
      data-cv-transition={snapshot.transition}
      hidden
      aria-hidden="true"
    >
      {snapshot.slots.map((slot) => (
        <li
          key={slot.slot}
          data-slot={slot.slot}
          data-card={slot.facing === 'up' ? slot.card : ''}
          data-facing={slot.facing}
          data-status={slot.status}
        />
      ))}
    </ol>
  );
}
