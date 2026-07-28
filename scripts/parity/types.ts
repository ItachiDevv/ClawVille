import type {
  CardFacing,
  CardParityRoot as AppCardParityRoot,
  Surface,
} from '../../apps/web/src/lib/cove/card-parity-mirror';
import type { Driver } from './driver';

export type { CardFacing, Surface };

export interface CardParityRoot extends AppCardParityRoot {
  observedAt?: number;
}

export type ParityGame = 'holdem' | 'blackjack' | 'baccarat';
export type ParityTier = 'guest' | 'live';
export type MatrixStatus = 'PASS' | 'FAIL' | 'UNPROVEN' | 'BLOCKED';

export interface WireRecord {
  seq: number;
  capturedAt?: number;
  method: string;
  url: string;
  urlSuffix: string;
  status: number;
  requestBody: unknown;
  responseBody: unknown;
  handId: string | null;
  handNumber: number | null;
  coupId: string | null;
  shoeId: string | null;
  idempotencyKey: string | null;
  fixtureHeaderInjected?: boolean;
}

export interface ExpectedSlot {
  card: string;
  facing: CardFacing;
  status?: string;
}

export interface ExpectedParity {
  slots: Record<string, ExpectedSlot>;
  meta: Record<string, string>;
}

export interface Mismatch {
  slot: string;
  field: 'card' | 'facing' | 'status' | `meta:${string}`;
  expected: string;
  actual: string;
}

export interface ParityCheckpoint {
  label: string;
  surface: Surface;
  expectRevisionAdvance: true;
  expectCausalCardJustification?: true;
  expectRenderRevision?: number;
  expectDealStep?: string;
  expectCorrelationHand?: string;
  actionFloorRevision?: number;
  expectMinPlayerCards?: number;
  expectResolvedWire?: '<none>';
  expectResolvedWireSuffix?: string;
  expectTransition?: CardParityRoot['transition'];
  final?: boolean;
}

export interface ScenarioDefinition {
  id: string;
  row: string;
  game: ParityGame;
  tier: ParityTier;
  surface: Surface;
  name: string;
  required: boolean;
  phases: readonly string[];
  fixtureName?: string;
  blockedReason?: string;
  feltReplay: 'rendered-state-only' | 'not-applicable';
  reachedPredicate: (wire: unknown) => boolean;
  run: (driver: Driver) => AsyncGenerator<ParityCheckpoint>;
  teardown: (driver: Driver, apiBase: string) => Promise<void>;
}

export interface CheckpointResult {
  label: string;
  revision: number;
  correlationHand: string;
  surface: Surface;
  pass: boolean;
  mismatches: Mismatch[];
  resolvedWireSeq: number | null;
  expectedResolvedWire?: '<none>';
  screenshot?: string;
}

export interface ScenarioResult {
  scenario: string;
  game: ParityGame;
  tier: ParityTier;
  surface: Surface;
  required: boolean;
  reached: boolean;
  pass: boolean;
  status: MatrixStatus;
  phases: readonly string[];
  checkpoints: CheckpointResult[];
  visibleSurface: Record<string, {
    expected: string | number | boolean | null;
    actual: string | number | boolean | null;
    pass: boolean;
  }>;
  money: {
    equation: string;
    values: Record<string, string>;
    pass: boolean;
    reason?: string;
  };
  blockedReason?: string;
  screenshots: string[];
}

export interface RecordedCase {
  id: string;
  game: ParityGame;
  root: CardParityRoot;
  records: WireRecord[];
  expectedDealStep: string;
  final: boolean;
}
