import { diffParity } from './diff';
import { expectedFromWire } from './expected-from-wire';
import { resolveWireForRoot } from './wire-correlation';
import type {
  CardParityRoot,
  CheckpointResult,
  Mismatch,
  ParityCheckpoint,
  ParityGame,
  WireRecord,
} from './types';

export interface AssertCheckpointInput {
  game: ParityGame;
  checkpoint: ParityCheckpoint;
  root: CardParityRoot;
  records: readonly WireRecord[];
  previousRevision?: number;
  ba1Snapshot?: unknown;
}

function rootMismatch(
  field: Mismatch['field'],
  expected: string,
  actual: string,
): Mismatch {
  return { slot: '<root>', field, expected, actual };
}

export function assertParityCheckpoint({
  game,
  checkpoint,
  root,
  records,
  previousRevision = 0,
  ba1Snapshot,
}: AssertCheckpointInput): CheckpointResult {
  const rootMismatches: Mismatch[] = [];
  if (root.surface !== checkpoint.surface) {
    rootMismatches.push(rootMismatch(
      'meta:surface',
      checkpoint.surface,
      root.surface,
    ));
  }
  if (root.version !== 2) {
    rootMismatches.push(rootMismatch('meta:version', '2', String(root.version)));
  }
  if (root.renderRevision <= previousRevision) {
    rootMismatches.push(rootMismatch(
      'meta:render-revision',
      `>${previousRevision}`,
      String(root.renderRevision),
    ));
  }
  if (
    checkpoint.expectRenderRevision !== undefined
    && root.renderRevision !== checkpoint.expectRenderRevision
  ) {
    rootMismatches.push(rootMismatch(
      'meta:render-revision-exact',
      String(checkpoint.expectRenderRevision),
      String(root.renderRevision),
    ));
  }
  if (checkpoint.expectDealStep !== undefined
    && root.dealStep !== checkpoint.expectDealStep) {
    rootMismatches.push(rootMismatch(
      'meta:deal-step',
      checkpoint.expectDealStep,
      root.dealStep,
    ));
  }
  if (checkpoint.expectCorrelationHand !== undefined
    && root.correlation.hand !== checkpoint.expectCorrelationHand) {
    rootMismatches.push(rootMismatch(
      'meta:correlation-hand',
      checkpoint.expectCorrelationHand,
      root.correlation.hand,
    ));
  }
  if (checkpoint.final && root.transition !== 'idle') {
    rootMismatches.push(rootMismatch(
      'meta:transition',
      'idle',
      root.transition,
    ));
  }
  if (checkpoint.expectTransition !== undefined
    && root.transition !== checkpoint.expectTransition) {
    rootMismatches.push(rootMismatch(
      'meta:transition',
      checkpoint.expectTransition,
      root.transition,
    ));
  }

  const wire = resolveWireForRoot(root, records);
  if (!wire) {
    rootMismatches.push(rootMismatch(
      'meta:resolved-wire',
      root.correlation.hand,
      '<none>',
    ));
    return {
      label: checkpoint.label,
      revision: root.renderRevision,
      correlationHand: root.correlation.hand,
      surface: root.surface,
      pass: false,
      mismatches: rootMismatches,
      resolvedWireSeq: null,
    };
  }

  const expected = expectedFromWire(
    game,
    root.surface,
    wire,
    ba1Snapshot,
    { root, records },
  );
  const compared = diffParity(expected, root);
  const mismatches = [...rootMismatches, ...compared.mismatches];
  return {
    label: checkpoint.label,
    revision: root.renderRevision,
    correlationHand: root.correlation.hand,
    surface: root.surface,
    pass: mismatches.length === 0,
    mismatches,
    resolvedWireSeq: wire.seq,
  };
}

export function assertOrderedDealSteps(
  roots: readonly CardParityRoot[],
  expectedSteps: readonly string[],
): { pass: boolean; message: string } {
  const ordered = roots
    .slice()
    .sort((left, right) => left.renderRevision - right.renderRevision);
  const selected: CardParityRoot[] = [];
  let afterRevision = -1;
  for (const step of expectedSteps) {
    const root = ordered.find(
      (candidate) => candidate.renderRevision > afterRevision
        && candidate.dealStep === step,
    );
    if (!root) {
      return {
        pass: false,
        message: `missing ${step} after revision ${afterRevision}`,
      };
    }
    selected.push(root);
    afterRevision = root.renderRevision;
  }
  const actual = selected.map((root) => root.dealStep);
  const revisions = selected.map((root) => root.renderRevision);
  const pass = selected.length === expectedSteps.length;
  return {
    pass,
    message: pass
      ? `${actual.join(' -> ')} (strict revisions ${revisions.join(' < ')})`
      : `expected ${expectedSteps.join(' -> ')}, got ${actual.join(' -> ')}; revisions=${revisions.join(',')}`,
  };
}
