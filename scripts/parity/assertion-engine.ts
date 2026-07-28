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

function causalWiresForRoot(
  root: CardParityRoot,
  records: readonly WireRecord[],
): WireRecord[] {
  if (root.observedAt === undefined) return [];
  return records
    .filter((record) => (
      record.capturedAt !== undefined
      && record.capturedAt <= root.observedAt!
      && resolveWireForRoot(root, [record]) !== null
    ))
    .sort((left, right) => (
      (right.capturedAt ?? 0) - (left.capturedAt ?? 0)
      || right.seq - left.seq
    ));
}

function isHoldemHandBoundary(
  root: CardParityRoot,
  records: readonly WireRecord[],
): boolean {
  if (
    root.dealStep === 'showdown'
    || root.dealStep === 'settled'
    || root.phase === 'settled'
    || root.phase === 'idle'
  ) return true;
  if (root.observedAt === undefined) return false;
  const separator = root.correlation.hand.lastIndexOf(':');
  if (separator <= 0) return false;
  const tableId = root.correlation.hand.slice(0, separator);
  // These records classify a reset boundary only; causal card justification
  // above remains strictly same-hand and at-or-before the journal timestamp.
  return records.some((record) => (
    record.capturedAt !== undefined
    && record.capturedAt <= root.observedAt!
    && (
      (
        record.urlSuffix === `poker/cash/tables/${tableId}/state-for-agent`
        && (
          (
            record.status === 409
            && (
              record.responseBody === null
              || (
                typeof record.responseBody === 'object'
                && !Array.isArray(record.responseBody)
                && (record.responseBody as Record<string, unknown>).message
                  === 'not_seated_or_no_live_hand'
              )
            )
          )
          || (
            record.status >= 200
            && record.status < 300
            && root.correlation.handNumber !== null
            && record.handNumber !== null
            // The private poll can advance before the public projection. That
            // makes freshSelf null and clears the old-hand tray under its last
            // street stamp, but cannot justify any card in that old hand.
            && record.handNumber > root.correlation.handNumber
          )
        )
      )
      || (
        record.status >= 200
        && record.status < 300
        && record.urlSuffix.startsWith(
          `poker/cash/tables/${tableId}/last-settled`,
        )
        && record.handNumber === root.correlation.handNumber
      )
    )
  ));
}

function causalSurfaceWitness(
  root: CardParityRoot,
  causalWires: readonly WireRecord[],
): WireRecord | null {
  const aligned = root.surface === 'holdem-tray-3d'
    ? causalWires.filter((wire) => /state-for-agent/.test(wire.urlSuffix))
    : root.surface === 'holdem-felt-3d'
      ? causalWires.filter((wire) => (
          /poker\/cash\/tables\/[^/?]+$/.test(wire.urlSuffix)
        ))
      : [];
  return aligned[0] ?? resolveWireForRoot(root, causalWires);
}

function assertCausalHoldemCards(
  root: CardParityRoot,
  records: readonly WireRecord[],
  ba1Snapshot: unknown,
): {
  mismatches: Mismatch[];
  resolvedWire: WireRecord | null;
} {
  const mismatches: Mismatch[] = [];
  const causalWires = causalWiresForRoot(root, records);
  const resolvedWire = causalSurfaceWitness(root, causalWires);
  if (root.observedAt === undefined) {
    mismatches.push(rootMismatch(
      'meta:journal-publish-time',
      '<timestamp>',
      '<none>',
    ));
  }
  if (!resolvedWire) {
    mismatches.push(rootMismatch(
      'meta:resolved-wire',
      root.correlation.hand,
      '<none-at-or-before-revision>',
    ));
  }

  const justifiedCards = new Map<string, Set<string>>();
  for (const wire of causalWires) {
    const expected = expectedFromWire(
      'holdem',
      root.surface,
      wire,
      ba1Snapshot,
      { root, records: causalWires },
    );
    for (const [slot, value] of Object.entries(expected.slots)) {
      if (value.facing !== 'up' || value.card === '') continue;
      const cards = justifiedCards.get(slot) ?? new Set<string>();
      cards.add(value.card);
      justifiedCards.set(slot, cards);
    }
  }

  const slots = new Map<string, CardParityRoot['slots'][number]>();
  const duplicateSlots = new Set<string>();
  for (const slot of root.slots) {
    if (slots.has(slot.slot)) duplicateSlots.add(slot.slot);
    else slots.set(slot.slot, slot);
  }
  for (const slot of [...duplicateSlots].sort()) {
    mismatches.push({
      slot,
      field: 'card',
      expected: '<unique>',
      actual: '<duplicate>',
    });
  }

  const handBoundary = isHoldemHandBoundary(root, records);
  const relevantSlotNames = new Set([
    ...slots.keys(),
    ...justifiedCards.keys(),
  ]);
  for (const slotName of [...relevantSlotNames].sort()) {
    const ownOrBoard = slotName.startsWith('hole-')
      || slotName.startsWith('board-');
    const opponent = slotName.startsWith('opp-');
    if (!ownOrBoard && !opponent) continue;
    const actual = slots.get(slotName);
    const justified = justifiedCards.get(slotName) ?? new Set<string>();
    const expectedCards = [...justified].sort().join('|');

    if (!actual || actual.card === '') {
      if (actual?.facing === 'up') {
        mismatches.push({
          slot: slotName,
          field: 'facing',
          expected: 'down|empty',
          actual: actual.facing,
        });
      }
      if (ownOrBoard && justified.size > 0 && !handBoundary) {
        mismatches.push({
          slot: slotName,
          field: 'card',
          expected: expectedCards,
          actual: actual?.card ?? '<absent>',
        });
      }
      continue;
    }

    if (actual.facing !== 'up') {
      mismatches.push({
        slot: slotName,
        field: 'facing',
        expected: 'up',
        actual: actual.facing,
      });
    }
    if (!justified.has(actual.card)) {
      mismatches.push({
        slot: slotName,
        field: 'card',
        expected: expectedCards || '<concealed>',
        actual: actual.card,
      });
    }
  }
  return { mismatches, resolvedWire };
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
  if (checkpoint.expectMinPlayerCards !== undefined) {
    const actualPlayerCards = root.slots.filter((slot) => (
      slot.slot.startsWith('player-')
      && slot.facing === 'up'
      && slot.card.length > 0
    )).length;
    if (actualPlayerCards < checkpoint.expectMinPlayerCards) {
      rootMismatches.push(rootMismatch(
        'meta:player-card-floor',
        `>=${checkpoint.expectMinPlayerCards}`,
        String(actualPlayerCards),
      ));
    }
  }

  if (checkpoint.expectCausalCardJustification) {
    const causal = assertCausalHoldemCards(root, records, ba1Snapshot);
    const mismatches = [...rootMismatches, ...causal.mismatches];
    return {
      label: checkpoint.label,
      revision: root.renderRevision,
      correlationHand: root.correlation.hand,
      surface: root.surface,
      pass: mismatches.length === 0,
      mismatches,
      resolvedWireSeq: causal.resolvedWire?.seq ?? null,
    };
  }

  const wire = resolveWireForRoot(root, records);
  if (checkpoint.expectResolvedWire === '<none>') {
    if (wire) {
      rootMismatches.push(rootMismatch(
        'meta:resolved-wire',
        '<none>',
        String(wire.seq),
      ));
    }
    for (const slot of root.slots.filter(
      (candidate) => candidate.slot.startsWith('opp-')
        && (candidate.facing === 'up' || candidate.card !== ''),
    )) {
      rootMismatches.push({
        slot: slot.slot,
        field: 'facing',
        expected: 'down|empty',
        actual: slot.facing,
      });
    }
    return {
      label: checkpoint.label,
      revision: root.renderRevision,
      correlationHand: root.correlation.hand,
      surface: root.surface,
      pass: rootMismatches.length === 0,
      mismatches: rootMismatches,
      resolvedWireSeq: wire?.seq ?? null,
      expectedResolvedWire: '<none>',
    };
  }
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
  if (
    checkpoint.expectResolvedWireSuffix !== undefined
    && !wire.urlSuffix.endsWith(checkpoint.expectResolvedWireSuffix)
  ) {
    rootMismatches.push(rootMismatch(
      'meta:resolved-wire',
      checkpoint.expectResolvedWireSuffix,
      wire.urlSuffix,
    ));
  }

  const expected = expectedFromWire(
    game,
    root.surface,
    wire,
    ba1Snapshot,
    { root, records },
  );
  if (checkpoint.expectMinPlayerCards !== undefined) {
    const expectedPlayerCards = Object.entries(expected.slots).filter(
      ([slot, value]) => (
        slot.startsWith('player-')
        && value.facing === 'up'
        && value.card.length > 0
      ),
    ).length;
    if (expectedPlayerCards < checkpoint.expectMinPlayerCards) {
      rootMismatches.push(rootMismatch(
        'meta:wire-player-card-floor',
        `>=${checkpoint.expectMinPlayerCards}`,
        String(expectedPlayerCards),
      ));
    }
  }
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
