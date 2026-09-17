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

/**
 * The operator's DEFAULT saved delivery address id, cached in-process.
 *
 * `dd-cli search` with no location flag searches Cupertino, CA — it does not
 * error, it just returns an empty store list, so a New York operator sees
 * "nothing found" instead of "wrong city". Anchoring every search to the saved
 * default is what makes results correct. Cached for 10 minutes so a search
 * costs one subprocess call, not two; the vendor warns `address list` is not
 * deduped and `address set` is account-wide, so a stale pick self-corrects
 * within the TTL. `is_default` is documented as best-effort and can be false
 * for every row, so fall back to the first address rather than giving up.
 */
const ADDRESS_CACHE_MS = 10 * 60 * 1000;
let addressCache: { id: string | null; at: number } | null = null;

async function defaultAddressId(): Promise<string | null> {
  if (addressCache && Date.now() - addressCache.at < ADDRESS_CACHE_MS) return addressCache.id;
  const result = await runDdCli<{ addresses: DdAddress[] }>('address-list', []);
  if (!result.ok) return addressCache?.id ?? null; // Keep a stale id over none.
  const rows = result.data.addresses ?? [];
  const chosen = rows.find((row) => row.is_default) ?? rows[0];
  // The schema permits a numeric address_id; the CLI flag takes a string.
  const id = chosen?.address_id === undefined || chosen.address_id === null
    ? null
    : String(chosen.address_id);
  addressCache = { id, at: Date.now() };
  return id;
}

/** Test seam: drop the cached address so a suite never leaks state across cases. */
export function resetDoordashAddressCache(): void {
  addressCache = null;
}

export function buildDoordashBridge(
  subject: DoordashSubject,
  requesterTurn: string,
): DoordashBridge {
  return {
    subject,
    requesterTurn,
    // Values only; the wrapper owns flags and validation (docs/ddcli-help/search.txt).
    // The default saved address is resolved first: without it the vendor searches
    // Cupertino, CA and returns an empty list (confirmed on staging 2026-09-17).
    // A resolution failure is NOT fatal — we fall back to an unanchored search
    // rather than denying the operator a result, since the vendor still answers.
    async search({ query }) {
      const addressId = await defaultAddressId();
      return runDdCli<DdSearchResult>('search', addressId ? [query, addressId] : [query]);
    },
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
