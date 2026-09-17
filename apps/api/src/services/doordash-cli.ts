import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
// The package barrel is outside this chunk. Consume its normal build output.
// NOTE: this reaches into `packages/shared/dist/`, a GITIGNORED build artifact.
// A stale build silently changes DD_CLI_PINNED_VERSION, which would make the
// version probe mismatch. That fails CLOSED through the dark latch rather than
// running the wrong binary, so the risk is contained — but if the pinned
// version ever looks wrong, rebuild packages/shared before debugging anything.
import {
  DD_CLI_INTENTS, DD_CLI_OPERATIONS, DD_CLI_PINNED_VERSION,
  type DdCliOperation,
} from '../../../../packages/shared/dist/constants/doordash.js';
import { alertError } from './alert-error';
import { withKeyedMutex } from './keyed-mutex';
import { redactBearerTokens } from './log-redact';

export type DdCliFailure =
  | 'ddcli_unavailable' | 'ddcli_version_mismatch' | 'ddcli_auth_expired'
  | 'ddcli_timeout' | 'ddcli_output_too_large' | 'ddcli_bad_json'
  | 'ddcli_nonzero' | 'ddcli_darkened';
export interface DdCliOk<T> { ok: true; data: T; durationMs: number }
export interface DdCliErr { ok: false; failure: DdCliFailure; detail: string; durationMs: number }
export type DdCliResult<T> = DdCliOk<T> | DdCliErr;

const DD_CLI_MAX_STDOUT_BYTES = 512 * 1024; // Independent limit for EACH stream.
const DD_CLI_HOME = process.env.DD_CLI_HOME ?? '/var/lib/ddcli';
const timeoutValue = process.env.DOORDASH_CMD_TIMEOUT_MS ?? '45000';
const timeoutMs = Number(timeoutValue);
if (!/^\d+$/.test(timeoutValue) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 120000) {
  throw new Error('DOORDASH_CMD_TIMEOUT_MS must be an integer from 5000 through 120000');
}

function resolveBinary(): string | null {
  const configured = process.env.DD_CLI_BIN ?? '/opt/ddcli/dd-cli';
  if (!isAbsolute(configured) || !isAbsolute(DD_CLI_HOME)) return null;
  try {
    const path = realpathSync(configured);
    if (!statSync(path).isFile()) return null;
    accessSync(path, constants.X_OK);
    return path;
  } catch { return null; }
}
const binary = resolveBinary();
let dark: { dark: boolean; since: string | null; reason: string | null } = { dark: false, since: null, reason: null };
let versionVerified = false;
let consecutiveTimeouts = 0;
// A killed child can take time to reap. Refuse another spawn until it exits,
// even after the bounded timeout path releases the mutex and returns a result.
let activeChild = false;
let shutdownPending = false;

export function ddCliBinPath(): string | null { return binary; }
export function isDoordashAvailable(): boolean { return binary !== null && !dark.dark && !shutdownPending; }
export function doordashDarkState(): { dark: boolean; since: string | null; reason: string | null } { return { ...dark }; }

// TODO: Populate ONLY with exit-code + stderr pairs from the staging expiry
// drill (spec 3.3.5). No guessed '401', 'expired', or authentication patterns.
const AUTH_EXPIRY_PATTERNS: readonly { exitCode: number; stderr: RegExp }[] = [];

const id = z.union([z.string().min(1), z.number().int().nonnegative()]);
const itemSchema = z.object({ item_id: id, name: z.string().optional() });
const addressSchema = z.object({
  address_id: id, printable_address: z.string(), label: z.string().nullable().optional(),
  is_default: z.boolean().optional(),
});
// The vendor returns the display name as `name`, NOT `store_name` (confirmed on
// staging 2026-09-17 — a live search for "mcdonalds" returns
// {"store_id":"837211","name":"McDonald's",...}). Zod strips unknown keys, so
// reading only `store_name` silently dropped every name and the chat bar
// rendered five results as "Restaurant (store 837211)". Accept BOTH spellings
// and normalize to `store_name` so callers stay unchanged.
const storeSchema = z.object({
  store_id: id,
  store_name: z.string().optional(),
  name: z.string().optional(),
}).transform(({ store_id, store_name, name }) => ({ store_id, store_name: store_name ?? name }));
// PROMPT-INJECTION BOUNDARY. Keep this schema NARROW on purpose: Zod strips
// unknown keys, so vendor fields that carry agent-directed imperative text
// never reach the model. The live `search` response ships a `message` ending
// "If the user names one of these restaurants, call get_restaurant_menu with
// its store_id — do NOT call find_restaurants again" (upstream MCP guidance
// naming tools that do not exist in this CLI; DoorDash issue #118), plus an
// `assistant_instructions` key the vendor's own docs say to ignore. Both are
// dropped here. Do NOT widen this schema to pass `message` through.
const searchSchema = z.object({ stores: z.array(storeSchema) });
const menuSchema = z.object({ menu_id: id, items: z.array(itemSchema) });
// Same `name` vs `store_name` tolerance as storeSchema. Order history was empty
// on the staging account, so the live spelling here is UNCONFIRMED — accepting
// both is the safe reading rather than guessing one.
const orderSummarySchema = z.object({
  order_uuid: z.string().min(1),
  store_id: id,
  store_name: z.string().optional(),
  name: z.string().optional(),
}).transform(({ order_uuid, store_id, store_name, name }) => ({ order_uuid, store_id, store_name: store_name ?? name }));
// `status` is deliberately NOT an enum. A strict list fails the whole parse the
// moment DoorDash adds a state, and the call that breaks is `order status` —
// precisely the call the founder makes after an ambiguous submit to find out
// whether he was charged. Breaking the recovery path to reject an unfamiliar
// string is the wrong trade. The action already renders an unknown status
// safely, and that fallback was unreachable while this enum stood.
const statusSchema = z.object({
  order_uuid: z.string().min(1).optional(),
  status: z.string().min(1).max(64),
});
// ---------------------------------------------------------------------------
// Phase 2 shapes. Every one below was CAPTURED FROM THE LIVE CLI on 2026-09-17
// (v0.2.4, founder account, Jacksonville default address) except the submit
// response, which is called out where it is defined. The Phase 1 post-mortem
// is the reason for that rule: three defects shipped because a mocked shape
// stood in for an observed one, and all three passed 99 green tests.
const moneySchema = z.object({
  unit_amount: z.number().int(),
  display_string: z.string().optional(),
});
// LIVE: quantity comes back as a float (`2.0`) even for whole counts.
const cartItemSchema = z.object({
  // Cart LINE id — what `cart remove-item` takes. Accepts a number as well as a
  // string for the same reason every other id here does: a numeric id would
  // otherwise take out cart show, add AND remove wholesale.
  id,
  item_id: id,
  name: z.string().optional(),
  quantity: z.number().nonnegative().optional(),
  price: z.number().nonnegative().optional(), // UNIT price in dollars, not the line total.
}).transform((item) => ({ ...item, id: String(item.id) }));
// `cart add-items`, `cart show` and `cart remove-item` all return this shape.
// item_errors is REDUCED TO A COUNT on purpose: DoorDash issue #64 reports that
// a partial write still exits 0 with success:true and reports the failures only
// in item_errors, so the caller must be able to see that something was dropped.
// The error text itself is vendor-controlled prose and never crosses this
// boundary — see the prompt-injection note on searchSchema.
const cartSchema = z.object({
  cart_uuid: z.string().min(1),
  // Require ONLY what is read. `cart.id` duplicates `cart_uuid` and
  // `items_count` duplicates `items.length`; requiring either would let a
  // harmless vendor omission break every cart operation for no benefit.
  cart: z.object({
    store_id: id,
    store_name: z.string().optional(),
    items: z.array(cartItemSchema),
  }),
  item_errors: z.array(z.unknown()).optional(),
}).transform(({ cart_uuid, cart, item_errors }) => ({
  cart_uuid, cart, item_error_count: item_errors?.length ?? 0,
}));
// `order preview` without --fulfillment is READ-ONLY (docs/ddcli-help/order-preview.txt).
// `tip` is a TOP-LEVEL field in v0.2.4. The older `quote.tip_suggestion_details`
// is still present but always empty (DoorDash issue #80 describes that older
// location); read the new one. min_age_requirement and contains_alcohol_item
// are what the terms of service section 8(f) age gate is enforced from.
const previewSchema = z.object({
  cart_uuid: z.string().min(1),
  quote: z.object({
    line_items: z.array(z.object({
      charge_id: z.string().optional(),
      label: z.string().optional(),
      final_money: moneySchema.optional(),
    })).optional(),
    total_before_tip: moneySchema,
    // The basket, so a confirmation reply can list what is actually in it.
    // LIVE-CONFIRMED 2026-09-17 that names arrive here, so no second CLI call
    // is needed. Kept to name and quantity only: the prompt-injection boundary
    // stays tight, and descriptions are vendor prose with no business here.
    store_order_cart: z.object({
      // LIVE-CONFIRMED 2026-09-17: the priced quote names its own store, so the
      // confirmation line can say WHERE the order goes without a second call.
      store: z.object({ name: z.string().optional() }).optional(),
      orders: z.array(z.object({
        order_items: z.array(z.object({
          quantity: z.number().nonnegative().optional(),
          item: z.object({ name: z.string().optional() }).optional(),
        })).optional(),
      })).optional(),
    }).optional(),
    min_age_requirement: z.number().int().nonnegative().optional(),
    contains_alcohol_item: z.boolean().optional(),
    delivery_availability: z.object({
      asap_available: z.boolean().optional(),
      is_within_delivery_region: z.boolean().optional(),
      asap_minutes_range_string: z.string().optional(),
    }).optional(),
  }),
  tip: z.object({
    suggested: z.object({
      amount_cents: z.number().int().nonnegative().optional(),
      display: z.string().optional(),
    }).optional(),
    options: z.array(z.object({
      amount_cents: z.number().int().nonnegative(),
      display: z.string().optional(),
      is_default: z.boolean().optional(),
    })).optional(),
  }).optional(),
});
// THE ONE SHAPE HERE THAT IS NOT LIVE-CAPTURED, and deliberately so: capturing
// it costs a real order on the founder's real card. It is transcribed from the
// vendor's own documented success response (DoorDash issue #56 quotes it
// verbatim from a real submit). Kept maximally tolerant — only order_uuid is
// required, because that uuid is the ONLY recovery handle if anything after
// this point is ambiguous. Treat any deviation as ambiguous, never as failure.
const submitSchema = z.object({
  order_uuid: z.string().min(1),
  processing_status: z.string().optional(),
});
export type DdCart = z.infer<typeof cartSchema>;
export type DdPreview = z.infer<typeof previewSchema>;
export type DdSubmit = z.infer<typeof submitSchema>;
export type DdSearchResult = z.infer<typeof searchSchema>;
export type DdMenu = z.infer<typeof menuSchema>;
export type DdAddress = z.infer<typeof addressSchema>;
export type DdOrderSummary = z.infer<typeof orderSummarySchema>;
export type DdOrderStatus = z.infer<typeof statusSchema>;

// Required fields come from each captured help file. Unknown fields are stripped:
// widget instructions and other unvalidated response fields never escape this boundary.
// No live JSON fixtures exist yet; unexpected vendor envelopes fail closed.
const schemas: Record<DdCliOperation, z.ZodTypeAny> = {
  version: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }), // root.txt
  'address-list': z.object({ addresses: z.array(addressSchema) }), // address-list.txt
  search: searchSchema, // search.txt
  menu: menuSchema, // menu.txt
  'find-items': z.object({ results: z.record(z.array(itemSchema)) }), // find-items.txt
  'item-details': z.object({ item_id: id, menu_id: id }), // item-details.txt
  'cart-show': cartSchema, // cart-show.txt
  'cart-add': cartSchema, // cart-add-items.txt
  'cart-remove': cartSchema, // cart-remove-item.txt
  'order-preview': previewSchema, // order-preview.txt
  'order-submit': submitSchema, // order-submit.txt
  'order-status': statusSchema, // order-status.txt
  'order-history': z.object({ orders: z.array(orderSummarySchema), page_full: z.boolean().optional() }), // order-history.txt
};

const value = z.string().min(1).max(1000).refine((s) => !/[\u0000-\u001f]/.test(s) && !s.startsWith('-'));
const identifier = z.string().min(1).max(1000).regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
const numericId = z.string().min(1).max(1000).regex(/^\d+$/);
const uuidValue = z.string().uuid();
// Whole counts only. DoorDash issue #92: a fractional quantity crashes the CLI
// ("'float' object cannot be interpreted as an integer"), so by-weight items
// are not orderable through this path at all. 1..20 keeps a typo from turning
// into a real charge for twenty thousand garlic knots.
const quantityValue = z.string().regex(/^(?:[1-9]|1\d|20)$/);
const tipValue = z.string().regex(/^\d{1,5}$/);
const argumentSchemas = {
  // search takes an OPTIONAL saved address id as the second value — see argvFor.
  version: z.tuple([]), 'address-list': z.tuple([]), search: z.union([z.tuple([value]), z.tuple([value, numericId])]),
  menu: z.tuple([identifier]), 'find-items': z.tuple([numericId, value]),
  'item-details': z.tuple([numericId, identifier]),
  'order-status': z.tuple([identifier]), 'order-history': z.tuple([]),
  // [storeId, menuId, itemId, quantity] opens a NEW cart; a 5th value adds to
  // an existing one. The items-json payload is BUILT HERE from these validated
  // values — a caller never hands this wrapper raw JSON, so no caller can slip
  // an extra field (a spend limit, a group-cart url, a guest) into the cart.
  'cart-add': z.union([
    z.tuple([identifier, identifier, identifier, quantityValue]),
    z.tuple([identifier, identifier, identifier, quantityValue, uuidValue]),
  ]),
  'cart-show': z.tuple([uuidValue]),
  'cart-remove': z.tuple([uuidValue, uuidValue]),
  'order-preview': z.tuple([uuidValue]),
  'order-submit': z.tuple([uuidValue, tipValue]),
} as const;

/**
 * Values only. The caller never supplies flags, JSON, or a command name — this
 * function owns every one of those, so the argv that reaches the vendor binary
 * is fixed by the operation and cannot be steered by chat text.
 */
function argvFor(op: DdCliOperation, args: readonly string[]): string[] | null {
  if (!(op in argumentSchemas)) return null;
  if (!argumentSchemas[op as keyof typeof argumentSchemas].safeParse(args).success) return null;
  let command: string[];
  switch (op) {
    // docs/ddcli-help/root.txt: eager --version exits before any service command.
    case 'version': return ['--json-output', '--version'];
    // docs/ddcli-help/address-list.txt
    case 'address-list': command = ['address', 'list']; break;
    // docs/ddcli-help/search.txt. CONFIRMED on staging 2026-09-17: with no
    // location flag the vendor silently searches lat 37.3346 / lng -122.009
    // (Cupertino, CA) and returns an empty list for a New York operator — the
    // results looked "empty", not "wrong city", which is the dangerous failure
    // mode. `--address-id` is mutually exclusive with --lat/--lng, so the
    // caller resolves the DEFAULT saved address and passes it as args[1].
    case 'search':
      command = args[1]
        ? ['search', '--query', args[0], '--address-id', args[1]]
        : ['search', '--query', args[0]];
      break;
    // docs/ddcli-help/menu.txt
    case 'menu': command = ['menu', '--store-id', args[0]]; break;
    // docs/ddcli-help/find-items.txt
    case 'find-items': command = ['find-items', '--store-id', args[0], '--query', args[1]]; break;
    // docs/ddcli-help/item-details.txt
    case 'item-details': command = ['item-details', '--store-id', args[0], '--item-id', args[1]]; break;
    // docs/ddcli-help/order-status.txt
    case 'order-status': command = ['order', 'status', '--order-uuid', args[0]]; break;
    // docs/ddcli-help/order-history.txt
    case 'order-history': command = ['order', 'history']; break;
    // docs/ddcli-help/cart-add-items.txt. item_name is required by the vendor
    // alongside item_id; the id is what resolves, so a server-owned placeholder
    // is passed rather than echoing caller text into the vendor payload.
    case 'cart-add': {
      const items = JSON.stringify([
        { item_id: args[2], item_name: 'item', quantity: Number(args[3]) },
      ]);
      command = ['cart', 'add-items', '--store-id', args[0], '--menu-id', args[1], '--items-json', items];
      if (args[4]) command.push('--cart-uuid', args[4]);
      break;
    }
    // docs/ddcli-help/cart-show.txt
    case 'cart-show': command = ['cart', 'show', '--cart-uuid', args[0]]; break;
    // docs/ddcli-help/cart-remove-item.txt: --cart-item-id is the cart LINE id
    // from `cart show` items[].id, NOT the menu item_id.
    case 'cart-remove':
      command = ['cart', 'remove-item', '--cart-uuid', args[0], '--cart-item-id', args[1]];
      break;
    // docs/ddcli-help/order-preview.txt. --fulfillment is NEVER passed: without
    // it preview is read-only, and with it preview MUTATES the cart's
    // fulfillment mode (DoorDash issue #59).
    case 'order-preview': command = ['order', 'preview', '--cart-uuid', args[0]]; break;
    // docs/ddcli-help/order-submit.txt. THE ONLY COMMAND HERE THAT SPENDS MONEY.
    // --yes skips the interactive confirmation, which a subprocess with no TTY
    // would otherwise abort on (DoorDash issue #79, fixed in v0.2.4). Our own
    // confirmation is the human's code in doordash-operator.ts, not this flag.
    case 'order-submit':
      command = ['order', 'submit', '--cart-uuid', args[0], '--tip-cents', args[1], '--yes'];
      break;
    default: return null;
  }
  // Global option position: docs/ddcli-help/root.txt; leaf intent: files above.
  return ['--json-output', ...command, '--intent', DD_CLI_INTENTS[op]];
}

/**
 * `--json-output` does NOT return the operation payload directly. Every service
 * command wraps it in an MCP-style envelope whose single text part carries the
 * real payload as an ENCODED JSON STRING:
 *   {"content":[{"type":"text","text":"{\"addresses\":[...]}"}]}
 * Verified against the live CLI on staging 2026-09-17 for address-list, search,
 * and order-history; before this, every non-version operation failed
 * `ddcli_bad_json` because the schema saw the envelope instead of the payload.
 * The unit tests missed it because they mocked the subprocess with the assumed
 * unwrapped shape. Anything that is NOT this envelope is passed through, so a
 * future vendor change back to a bare payload keeps working.
 */
function unwrapEnvelope(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !('content' in value)) return value;
  const { content } = value as { content: unknown };
  if (!Array.isArray(content)) return value;
  const part = content.find(
    (entry): entry is { type?: unknown; text: string } =>
      entry !== null && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string',
  );
  if (!part) return value;
  try {
    return JSON.parse(part.text) as unknown;
  } catch {
    // A non-JSON text part is a genuine shape change; let the schema reject it.
    return value;
  }
}

/**
 * Validate a CAPTURED vendor payload against an operation schema.
 *
 * Exists so a real response can be checked against the schema that will parse
 * it, without spawning the binary. Phase 1 shipped three defects because mocked
 * shapes stood in for observed ones; this is the seam that lets a live capture
 * be the thing under test. The payload is never retained by this function.
 */
export function parseDdCliPayload(op: DdCliOperation, raw: unknown): { ok: boolean; error?: string } {
  const parsed = schemas[op].safeParse(unwrapEnvelope(raw));
  return parsed.success ? { ok: true } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

function scrub(input: string, token: string): string {
  // Scrub the whole input BEFORE truncation to avoid leaking a token prefix.
  return redactBearerTokens(token ? input.split(token).join('<redacted>') : input);
}

function failure(code: DdCliFailure, detail: string, start: number, token: string): DdCliErr {
  const safeDetail = scrub(detail, token).slice(0, 200);
  const critical = code === 'ddcli_auth_expired' || code === 'ddcli_version_mismatch';
  if (critical) dark = { dark: true, since: new Date().toISOString(), reason: code };
  consecutiveTimeouts = code === 'ddcli_timeout' ? consecutiveTimeouts + 1 : 0;
  const warn = ['ddcli_output_too_large', 'ddcli_bad_json', 'ddcli_nonzero'].includes(code)
    || (code === 'ddcli_timeout' && consecutiveTimeouts === 3);
  if (critical || warn) {
    // Never pass stdout, stderr, argv, or structured vendor data to the alert channel.
    void alertError({ severity: critical ? 'critical' : 'warning', source: scrub('doordash-cli', token),
      message: scrub(code, token) }).catch(() => {});
  }
  return { ok: false, failure: code, detail: safeDetail, durationMs: Date.now() - start };
}

class OutputLimit extends Error {}
type CancellableReader = Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel'>;
async function readBounded(stream: ReadableStream<Uint8Array>, readers: CancellableReader[]): Promise<string> {
  const reader = stream.getReader();
  readers.push(reader);
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > DD_CLI_MAX_STDOUT_BYTES) throw new OutputLimit();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

async function invoke(op: DdCliOperation, argv: string[]): Promise<DdCliResult<unknown>> {
  const start = Date.now();
  const token = process.env.DD_CLI_ACCESS_TOKEN ?? '';
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn({
      cmd: [binary!, ...argv], stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { DD_CLI_ACCESS_TOKEN: token, HOME: DD_CLI_HOME,
        PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: join(DD_CLI_HOME, 'tmp'), LANG: 'C.UTF-8' },
      cwd: DD_CLI_HOME,
    });
  } catch { return failure('ddcli_unavailable', 'The DoorDash CLI could not start.', start, token); }
  activeChild = true;
  let exited = false;
  const exit = proc.exited.then((code) => { exited = true; activeChild = false; shutdownPending = false; return code; });
  const readers: CancellableReader[] = [];
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const output = Promise.all([exit, readBounded(proc.stdout, readers), readBounded(proc.stderr, readers)]);
  async function stop(): Promise<void> {
    try { proc.kill(); } catch { /* Process can exit between checks. */ }
    if (!exited) {
      let grace: ReturnType<typeof setTimeout>;
      await Promise.race([exit.catch(() => {}), new Promise<void>((resolve) => { grace = setTimeout(resolve, 2000); })]);
      clearTimeout(grace!);
      if (!exited) { try { proc.kill(9); } catch { /* Already exited. */ } }
    }
    shutdownPending = !exited;
    for (const reader of readers) { try { void reader.cancel().catch(() => {}); } catch { /* Reader already released. */ } }
  }
  try {
    const result = await Promise.race([output, timeout]);
    if (result === 'timeout') {
      await stop();
      return failure('ddcli_timeout', 'The DoorDash CLI exceeded its time limit.', start, token);
    }
    const [code, stdout, stderr] = result;
    if (code !== 0) {
      const expired = AUTH_EXPIRY_PATTERNS.some((pattern) => pattern.exitCode === code && pattern.stderr.test(stderr));
      return failure(expired ? 'ddcli_auth_expired' : 'ddcli_nonzero', stderr || 'The DoorDash CLI exited unsuccessfully.', start, token);
    }
    let raw: unknown;
    try {
      // root.txt documents a version-and-exit flag, not a JSON shape. Accept the
      // usual CLI text form as a compatibility assumption; confirm on staging.
      if (op === 'version') {
        const match = /^(?:dd-cli,?\s+(?:version\s+)?)?(\d+\.\d+\.\d+)\s*$/i.exec(stdout.trim());
        raw = match ? { version: match[1] } : JSON.parse(stdout);
      } else {
        const envelope = JSON.parse(stdout) as unknown;
        // The MCP envelope carries its OWN error flag, OUTSIDE the payload, and
        // unwrapping throws it away. The `success === false` guard below runs on
        // the unwrapped object and never sees it. That matters most on the one
        // command that spends money: `order submit` exiting 0 with
        // `isError: true` around a payload holding an order_uuid would otherwise
        // parse as a clean success and report a placed order that never charged.
        // Vendor behaviour here is UNVERIFIED — we have never made a real
        // submit — so this fails closed on the flag rather than trusting it.
        if (envelope !== null && typeof envelope === 'object'
          && (envelope as { isError?: unknown }).isError === true) {
          return failure('ddcli_bad_json', 'The DoorDash response is flagged as an error.', start, token);
        }
        raw = unwrapEnvelope(envelope);
      }
    } catch { return failure('ddcli_bad_json', scrub(stdout, token), start, token); }
    if (raw !== null && typeof raw === 'object' &&
      (('success' in raw && raw.success === false) || ('ok' in raw && raw.ok === false))) {
      return failure('ddcli_bad_json', 'The DoorDash response reports an unsuccessful operation.', start, token);
    }
    const parsed = schemas[op].safeParse(raw);
    if (!parsed.success) return failure('ddcli_bad_json', 'The DoorDash response does not match the operation schema.', start, token);
    if (op === 'version') {
      if (parsed.data.version !== DD_CLI_PINNED_VERSION) return failure('ddcli_version_mismatch', 'The DoorDash CLI version differs from the pinned version.', start, token);
      versionVerified = true;
      dark = { dark: false, since: null, reason: null };
    }
    consecutiveTimeouts = 0;
    return { ok: true, data: parsed.data as unknown, durationMs: Date.now() - start };
  } catch (error) {
    await stop();
    return failure(error instanceof OutputLimit ? 'ddcli_output_too_large' : 'ddcli_nonzero',
      error instanceof OutputLimit ? 'The DoorDash CLI exceeded its output limit.' : 'The DoorDash CLI output could not be read.', start, token);
  } finally { clearTimeout(timer!); }
}

export function runDdCli<T = unknown>(op: DdCliOperation, args: readonly string[]): Promise<DdCliResult<T>> {
  return withKeyedMutex('doordash-cli', async () => {
    const start = Date.now();
    const token = process.env.DD_CLI_ACCESS_TOKEN ?? '';
    // Allow an explicit version probe to recover the dark latch after a successful version match.
    if (dark.dark && op !== 'version') return failure('ddcli_darkened', 'DoorDash is unavailable until operator recovery.', start, token);
    if (!binary) return failure('ddcli_unavailable', 'The DoorDash CLI binary is unavailable.', start, token);
    if (activeChild) return failure('ddcli_unavailable', 'The previous DoorDash CLI process has not exited.', start, token);
    if (!DD_CLI_OPERATIONS.includes(op)) return failure('ddcli_unavailable', 'Unsupported DoorDash operation.', start, token);
    const argv = argvFor(op, args);
    if (!argv) return failure('ddcli_unavailable', 'Invalid DoorDash arguments.', start, token);
    if (op !== 'version' && !versionVerified) {
      const probe = await invoke('version', argvFor('version', [])!);
      if (!probe.ok) return probe;
    }
    const result = await invoke(op, argv);
    return { ...result, durationMs: Date.now() - start } as DdCliResult<T>;
  });
}
