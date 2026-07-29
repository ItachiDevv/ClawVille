import type {
  CardParityRoot,
  RecordedCase,
  WireRecord,
} from '../types';

function wire(
  value: Omit<WireRecord, 'method' | 'url' | 'status' | 'requestBody'>,
): WireRecord {
  return {
    method: 'POST',
    url: `http://127.0.0.1:4002/api/cove/${value.urlSuffix}`,
    status: 200,
    requestBody: {},
    ...value,
  };
}

const blackjackWire = wire({
  seq: 1,
  urlSuffix: 'blackjack/hand/deal',
  responseBody: {
    handId: 'bj-recorded-1',
    shoeId: 'bj-shoe-recorded',
    handIndex: 1,
    bet: '25',
    playerHand: [
      { suit: 'hearts', rank: '9' },
      { suit: 'clubs', rank: '7' },
    ],
    dealerUpcard: { suit: 'spades', rank: 'A' },
    insuranceOffered: true,
    tookInsurance: false,
    balance: 975,
    status: 'in_progress',
  },
  handId: 'bj-recorded-1',
  handNumber: null,
  coupId: null,
  shoeId: 'bj-shoe-recorded',
  idempotencyKey: 'bj-recorded-idem',
});

const blackjackRoot = {
  surface: 'blackjack-3d',
  version: 2,
  instanceId: 'recorded-bj',
  renderRevision: 11,
  correlation: {
    hand: 'bj-recorded-1',
    handNumber: null,
    shoe: 'bj-shoe-recorded',
  },
  dealStep: 'hole',
  phase: 'player-turn',
  transition: 'idle',
  slots: [
    { slot: 'player-0-card-1', facing: 'up', card: '9h' },
    { slot: 'player-0-card-2', facing: 'up', card: '7c' },
    { slot: 'dealer-card-1', facing: 'up', card: 'As' },
    { slot: 'dealer-card-2', facing: 'down', card: '' },
  ],
  meta: {
    'player-0-total': '16',
    'player-0-soft': 'false',
    'player-0-bust': 'false',
    'player-0-blackjack': 'false',
    'player-0-resolved': 'false',
    'active-slot': '0',
    'insurance-offered': 'true',
    'insurance-taken': 'false',
  },
} as unknown as CardParityRoot;

const baccaratWire = wire({
  seq: 2,
  urlSuffix: 'baccarat/coup',
  responseBody: {
    coupId: 'bac-recorded-1',
    shoeId: 'bac-shoe-recorded',
    coupIndex: 8,
    outcome: {
      bet: 'tie',
      stake: '25',
      player: {
        cards: [
          { suit: 'hearts', rank: '4' },
          { suit: 'clubs', rank: '5' },
        ],
        total: 9,
        isNatural: true,
      },
      banker: {
        cards: [
          { suit: 'diamonds', rank: 'K' },
          { suit: 'spades', rank: '9' },
        ],
        total: 9,
        isNatural: true,
      },
      winner: 'tie',
      commission: '0',
      net: '200',
    },
    balance: 1200,
    totalBet: '25',
    totalPayout: '225',
    net: '200',
    dealtCount: 4,
    reshuffleSuggested: false,
    idempotencyReplay: false,
    status: 'settled',
  },
  handId: null,
  handNumber: null,
  coupId: 'bac-recorded-1',
  shoeId: 'bac-shoe-recorded',
  idempotencyKey: 'bac-recorded-idem',
});

const baccaratRoot = {
  surface: 'baccarat-3d',
  version: 2,
  instanceId: 'recorded-bac',
  renderRevision: 21,
  correlation: {
    hand: 'bac-recorded-1',
    handNumber: null,
    shoe: 'bac-shoe-recorded',
  },
  dealStep: 'settled',
  phase: 'settled',
  transition: 'idle',
  slots: [
    { slot: 'player-1', facing: 'up', card: '4h' },
    { slot: 'player-2', facing: 'up', card: '5c' },
    { slot: 'player-3', facing: 'empty', card: '' },
    { slot: 'banker-1', facing: 'up', card: 'Kd' },
    { slot: 'banker-2', facing: 'up', card: '9s' },
    { slot: 'banker-3', facing: 'empty', card: '' },
  ],
  meta: {
    bet: 'tie',
    stake: '25',
    'player-total': '9',
    'player-natural': 'true',
    'banker-total': '9',
    'banker-natural': 'true',
    winner: 'tie',
    commission: '0',
    net: '200',
    'banner-text': 'TIE · YOU WIN',
    'betzone-selected': 'tie',
  },
} as unknown as CardParityRoot;

const baccaratIntermediateRoot = {
  ...baccaratRoot,
  renderRevision: 20,
  dealStep: 'player-2',
  phase: 'revealing',
  transition: 'revealing',
  slots: [
    { slot: 'player-1', facing: 'up', card: '4h' },
    { slot: 'player-2', facing: 'up', card: '5c' },
    { slot: 'player-3', facing: 'empty', card: '' },
    { slot: 'banker-1', facing: 'up', card: 'Kd' },
    { slot: 'banker-2', facing: 'empty', card: '' },
    { slot: 'banker-3', facing: 'empty', card: '' },
  ],
  meta: {
    bet: 'tie',
    stake: '25',
    'betzone-selected': 'tie',
  },
} as unknown as CardParityRoot;

const holdemWire = wire({
  seq: 3,
  urlSuffix: 'holdem/hand/deal',
  responseBody: {
    tableId: 'practice-table-recorded',
    handId: 'holdem-recorded-1',
    handIndex: 14,
    buttonSeat: 0,
    smallBlindSeat: 1,
    bigBlindSeat: 2,
    humanHole: [
      { suit: 'spades', rank: 'A' },
      { suit: 'diamonds', rank: '10' },
    ],
    board: [
      { suit: 'clubs', rank: '2' },
      { suit: 'hearts', rank: 'J' },
      { suit: 'spades', rank: 'Q' },
    ],
    toCall: '0',
    currentBet: '0',
    humanStack: '990',
    humanCommitted: '10',
    smallBlind: '5',
    bigBlind: '10',
    publicActionLog: [
      { seat: 1, street: 'preflop', type: 'small_blind', amount: '5', isHuman: false },
      { seat: 2, street: 'preflop', type: 'big_blind', amount: '10', isHuman: false },
      { seat: 0, street: 'preflop', type: 'call', amount: '10', isHuman: true },
      { seat: 3, street: 'preflop', type: 'call', amount: '10', isHuman: false },
    ],
    status: 'in_progress',
  },
  handId: 'holdem-recorded-1',
  handNumber: 14,
  coupId: null,
  shoeId: null,
  idempotencyKey: null,
});

const holdemRoot = {
  surface: 'holdem-tray-practice',
  version: 2,
  instanceId: 'recorded-holdem',
  renderRevision: 31,
  correlation: {
    hand: 'holdem-recorded-1',
    handNumber: 14,
  },
  dealStep: 'flop',
  phase: 'flop',
  transition: 'revealing',
  slots: [
    { slot: 'hole-1', facing: 'up', card: 'As' },
    { slot: 'hole-2', facing: 'up', card: 'Td' },
    { slot: 'board-1', facing: 'up', card: '2c' },
    { slot: 'board-2', facing: 'up', card: 'Jh' },
    { slot: 'board-3', facing: 'up', card: 'Qs' },
    { slot: 'board-4', facing: 'empty', card: '' },
    { slot: 'board-5', facing: 'empty', card: '' },
  ],
  meta: { pot: '35' },
} as unknown as CardParityRoot;

export const RECORDED_CASES: readonly RecordedCase[] = Object.freeze([
  {
    id: 'blackjack.correct-hole',
    game: 'blackjack',
    root: blackjackRoot,
    records: [blackjackWire],
    expectedDealStep: 'hole',
    final: false,
  },
  {
    id: 'baccarat.correct-intermediate',
    game: 'baccarat',
    root: baccaratIntermediateRoot,
    records: [baccaratWire],
    expectedDealStep: 'player-2',
    final: false,
  },
  {
    id: 'baccarat.correct-settled',
    game: 'baccarat',
    root: baccaratRoot,
    records: [baccaratWire],
    expectedDealStep: 'settled',
    final: true,
  },
  {
    id: 'holdem.correct-flop-tray',
    game: 'holdem',
    root: holdemRoot,
    records: [holdemWire],
    expectedDealStep: 'flop',
    final: false,
  },
]);
