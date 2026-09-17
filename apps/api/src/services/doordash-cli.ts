import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
// The package barrel is outside this chunk. Consume its normal build output.
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
const searchSchema = z.object({ stores: z.array(z.object({ store_id: id, store_name: z.string().optional() })) });
const menuSchema = z.object({ menu_id: id, items: z.array(itemSchema) });
const orderSummarySchema = z.object({ order_uuid: z.string().min(1), store_id: id, store_name: z.string().optional() });
const statusSchema = z.object({
  order_uuid: z.string().min(1).optional(),
  status: z.enum(['pending', 'action_required', 'order_declined', 'placed', 'scheduled',
    'store_confirmed', 'ready_for_pickup', 'dasher_assigned', 'dasher_at_store',
    'picked_up', 'dasher_nearby', 'completed', 'cancelled']),
});
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
  // Phase 2 is deliberately unavailable. There is no argv or permissive schema.
  'cart-show': z.never(), 'cart-add': z.never(), 'cart-remove': z.never(),
  'order-preview': z.never(), 'order-submit': z.never(),
  'order-status': statusSchema, // order-status.txt
  'order-history': z.object({ orders: z.array(orderSummarySchema), page_full: z.boolean().optional() }), // order-history.txt
};

const value = z.string().min(1).max(1000).refine((s) => !/[\u0000-\u001f]/.test(s) && !s.startsWith('-'));
const identifier = z.string().min(1).max(1000).regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
const numericId = z.string().min(1).max(1000).regex(/^\d+$/);
const argumentSchemas = {
  version: z.tuple([]), 'address-list': z.tuple([]), search: z.tuple([value]),
  menu: z.tuple([identifier]), 'find-items': z.tuple([numericId, value]),
  'item-details': z.tuple([numericId, identifier]),
  'order-status': z.tuple([identifier]), 'order-history': z.tuple([]),
} as const;

/** Values only: [query], [storeId], [storeId, query/itemId], [orderUuid], or []. */
function argvFor(op: DdCliOperation, args: readonly string[]): string[] | null {
  if (!(op in argumentSchemas)) return null;
  if (!argumentSchemas[op as keyof typeof argumentSchemas].safeParse(args).success) return null;
  let command: string[];
  switch (op) {
    // docs/ddcli-help/root.txt: eager --version exits before any service command.
    case 'version': return ['--json-output', '--version'];
    // docs/ddcli-help/address-list.txt
    case 'address-list': command = ['address', 'list']; break;
    // docs/ddcli-help/search.txt. Frozen bridge only supplies query: without
    // location flags the vendor falls back to Cupertino. Later integration
    // must resolve an explicit saved address before promising nearby results.
    case 'search': command = ['search', '--query', args[0]]; break;
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
    default: return null;
  }
  // Global option position: docs/ddcli-help/root.txt; leaf intent: files above.
  return ['--json-output', ...command, '--intent', DD_CLI_INTENTS[op]];
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
      } else raw = JSON.parse(stdout);
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
    if (!argv) return failure('ddcli_unavailable', op in argumentSchemas ? 'Invalid DoorDash arguments.' : 'This DoorDash operation ships in Phase 2.', start, token);
    if (op !== 'version' && !versionVerified) {
      const probe = await invoke('version', argvFor('version', [])!);
      if (!probe.ok) return probe;
    }
    const result = await invoke(op, argv);
    return { ...result, durationMs: Date.now() - start } as DdCliResult<T>;
  });
}
