import {
  runDdCli,
  type DdAddress,
  type DdCliResult,
  type DdMenu,
  type DdOrderStatus,
  type DdOrderSummary,
  type DdSearchResult,
} from './doordash-cli';

const OPERATOR_ID = (process.env.DOORDASH_OPERATOR_USER_ID ?? '').trim();
const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
);

/** The one enabled account must also be an admin. Both settings resolve at module load. */
export function doordashOperatorUserId(): string | null {
  return OPERATOR_ID && ADMIN_IDS.has(OPERATOR_ID) ? OPERATOR_ID : null;
}

export interface DoordashSubject {
  userId: string;
  avatarId: string;
  kind: 'human' | 'agent';
  /** Resolved agent session id for audit; never write the raw bearer to a log. */
  agentSessionId?: string;
  /** Only the Lucia human path can submit in Phase 2. */
  canSubmit: boolean;
}

/**
 * Consume identity from requireAuth / resolveAgentSession, never runtime state.userId.
 * Those upstream resolvers enforce session liveness, rotation, and avatar ownership.
 * Availability is independent: runDdCli checks the executable and the dark latch.
 */
export function resolveDoordashOperator(input:
  | { kind: 'human'; userId: string; avatarId: string }
  | { kind: 'agent'; userId: string | null; avatarId: string | null;
      ledgerCapable: boolean; agentSessionId: string },
): DoordashSubject | null {
  const operatorId = doordashOperatorUserId();
  if (!operatorId || input.userId !== operatorId || !input.avatarId?.trim()) return null;
  if (input.kind === 'agent') {
    if (input.ledgerCapable !== true || !input.agentSessionId?.trim()) return null;
    return {
      userId: operatorId, avatarId: input.avatarId, kind: 'agent',
      agentSessionId: input.agentSessionId, canSubmit: false,
    };
  }
  if (input.kind !== 'human') return null;
  return { userId: operatorId, avatarId: input.avatarId, kind: 'human', canSubmit: true };
}

// Reserved Phase 2 response types. The frozen spec names these without defining
// vendor fields; do not invent response contracts before that phase implements them.
export type DdCart = Readonly<Record<string, unknown>>;
export type DdPreviewWithConfirm = Readonly<Record<string, unknown>>;
export type DdOrder = Readonly<Record<string, unknown>>;

/** Per-message capability. No CLI output is retained here or persisted to memory. */
export interface DoordashBridge {
  subject: DoordashSubject;
  /** Raw requester turn, reserved exclusively for Phase 2 confirmation matching. */
  requesterTurn: string;
  search(q: { query: string }): Promise<DdCliResult<DdSearchResult>>;
  menu(q: { storeId: string }): Promise<DdCliResult<DdMenu>>;
  addresses(): Promise<DdCliResult<DdAddress[]>>;
  cartShow(q: { cartUuid: string }): Promise<DdCliResult<DdCart>>;
  cartAdd(q: { storeId: string; itemId: string; quantity: number }): Promise<DdCliResult<DdCart>>;
  cartRemove(q: { cartUuid: string; cartItemId: string }): Promise<DdCliResult<DdCart>>;
  preview(q: { cartUuid: string }): Promise<DdCliResult<DdPreviewWithConfirm>>;
  submit(q: { cartUuid: string; confirm: string }): Promise<DdCliResult<DdOrder>>;
  orderStatus(q: { orderUuid: string }): Promise<DdCliResult<DdOrderStatus>>;
  orderHistory(): Promise<DdCliResult<DdOrderSummary[]>>;
}

function phaseTwo(operation: string): never {
  throw new Error(`DoorDash ${operation} ships in Phase 2.`);
}

export function buildDoordashBridge(
  subject: DoordashSubject,
  requesterTurn: string,
): DoordashBridge {
  return {
    subject,
    requesterTurn,
    // Values only; the wrapper owns flags and validation (docs/ddcli-help/search.txt).
    search: ({ query }) => runDdCli<DdSearchResult>('search', [query]),
    // docs/ddcli-help/menu.txt: --store-id.
    menu: ({ storeId }) => runDdCli<DdMenu>('menu', [storeId]),
    // docs/ddcli-help/address-list.txt: native response has addresses[].
    async addresses() {
      const result = await runDdCli<{ addresses: DdAddress[] }>('address-list', []);
      return result.ok ? { ...result, data: result.data.addresses } : result;
    },
    async cartShow() { return phaseTwo('cartShow'); },
    async cartAdd() { return phaseTwo('cartAdd'); },
    async cartRemove() { return phaseTwo('cartRemove'); },
    async preview() { return phaseTwo('preview'); },
    async submit() { return phaseTwo('submit'); },
    // docs/ddcli-help/order-status.txt: --order-uuid.
    orderStatus: ({ orderUuid }) => runDdCli<DdOrderStatus>('order-status', [orderUuid]),
    // docs/ddcli-help/order-history.txt: native response has orders[].
    async orderHistory() {
      const result = await runDdCli<{ orders: DdOrderSummary[] }>('order-history', []);
      return result.ok ? { ...result, data: result.data.orders } : result;
    },
  };
}
