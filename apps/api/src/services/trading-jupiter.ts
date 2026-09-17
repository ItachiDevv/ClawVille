import { VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';

const atomicString = z.string().regex(/^\d+$/);
const positiveAtomicString = z.string().regex(/^[1-9]\d*$/);
const decimalString = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);

// Quote schemas are tolerant of additive keys (`.passthrough()` keeps them in the
// parsed output, so the quote echoed back into the swap request stays byte for
// byte what Jupiter returned). Every field we act on is still typed and bounded;
// a NEW upstream key must never refuse every fleet trade (2026-09-17 rung).
const reliableReportSchema = z.object({
  info: z.record(z.string(), atomicString),
}).passthrough();

const swapInfoSchema = z.object({
  ammKey: z.string(),
  label: z.string(),
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: atomicString,
  outAmount: positiveAtomicString,
  updateContextSlot: atomicString,
  feeAmount: atomicString.optional(),
  feeMint: z.string().optional(),
}).passthrough();

const routeStepSchema = z.object({
  swapInfo: swapInfoSchema,
  percent: z.number().int().min(0).max(100),
  bps: z.number().int().min(0).max(10_000).nullable(),
}).passthrough();

export const parsedJupiterQuoteSchema = z.object({
  inputMint: z.string(),
  inAmount: atomicString,
  outputMint: z.string(),
  outAmount: positiveAtomicString,
  otherAmountThreshold: positiveAtomicString,
  swapMode: z.literal('ExactIn'),
  slippageBps: z.number().int().min(1).max(10_000),
  platformFee: z.null(),
  priceImpactPct: decimalString,
  routePlan: z.array(routeStepSchema).min(1).max(4),
  contextSlot: z.number().int().nonnegative(),
  timeTaken: z.number().nonnegative(),
  swapUsdValue: decimalString,
  mostReliableAmmsQuoteReport: reliableReportSchema,
  longtailMarketQuoteReport: z.null(),
  useIncurredSlippageForQuoting: z.null(),
  useRewards: z.null(),
  // The immutable spec says array, but every recorded byte-identical fixture is null.
  otherRoutePlans: z.array(z.unknown()).nullable(),
  loadedLongtailToken: z.boolean(),
  additionalIntermediateTokens: z.array(z.string()).optional(),
  instructionVersion: z.literal('V1').nullable().optional(),
}).passthrough();

export type ParsedJupiterQuote = z.infer<typeof parsedJupiterQuoteSchema>;

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: ReadonlyArray<{ inputMint: string; outputMint: string }>;
  parsed: ParsedJupiterQuote;
}

/**
 * The swap-build response is NOT strict. The contract we enforce is the
 * transaction bytes: they are decoded, inspected instruction by instruction, and
 * simulated before admission (`trading-swap-validator.ts`), so an extra metadata
 * key from Jupiter carries no risk, while refusing on one blocks every fleet
 * trade (2026-09-17 staging $1 rung: `simulationSlot`,
 * `addressesByLookupTableAddress`, `timeTaken`, `createAtaTimeTaken` appeared
 * and the strict schema refused with `tx_binding_failed`). A non-null
 * `simulationError` still fails the parse, so Jupiter's own failed simulation
 * refuses the trade before ours runs; when Jupiter reports a `simulationSlot`
 * it simulated, so `simulationError` must then be present and null.
 */
const swapResponseSchema = z.object({
  swapTransaction: z.string().min(1),
  lastValidBlockHeight: z.number().int().positive(),
  prioritizationFeeLamports: z.number().int().nonnegative().optional(),
  computeUnitLimit: z.number().int().positive().optional(),
  prioritizationType: z.unknown().optional(),
  dynamicSlippageReport: z.unknown().optional(),
  simulationError: z.null().optional(),
  simulationSlot: z.number().int().nonnegative().nullable().optional(),
  // Unused: lookup tables are resolved from our own RPC by the keys inside the
  // transaction (`resolveLookups`), never from Jupiter's expansion.
  addressesByLookupTableAddress: z.unknown().optional(),
  timeTaken: z.number().nonnegative().optional(),
  createAtaTimeTaken: z.number().nonnegative().optional(),
}).passthrough().refine(
  (value) => value.simulationSlot === undefined || value.simulationSlot === null || value.simulationError === null,
  { message: 'simulationError must be present and null when Jupiter reports a simulationSlot' },
);

const ALLOWED_HOSTS = new Set(['lite-api.jup.ag', 'api.jup.ag']);

export function resolveTradingJupiterBaseUrl(): string {
  const configured = process.env.TRADING_JUPITER_BASE_URL?.trim();
  const raw = configured || (process.env.JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('[trading-floor] invalid TRADING_JUPITER_BASE_URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('[trading-floor] Jupiter base URL is not allowlisted');
  }
  return raw.replace(/\/+$/, '');
}

function requestHeaders(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY;
  return key ? { 'x-api-key': key } : {};
}

export async function fetchTradingQuote(input: {
  inputMint: string;
  outputMint: string;
  amountAtomic: bigint;
  slippageBps: number;
  fetchImpl?: typeof fetch;
}): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.amountAtomic.toString(),
    slippageBps: String(input.slippageBps),
    swapMode: 'ExactIn',
    instructionVersion: 'V1',
    restrictIntermediateTokens: 'true',
  });
  const response = await (input.fetchImpl ?? fetch)(`${resolveTradingJupiterBaseUrl()}/swap/v1/quote?${params}`, {
    headers: requestHeaders(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`quote_http_${response.status}`);
  const parsed = parsedJupiterQuoteSchema.parse(await response.json());
  if (parsed.inputMint !== input.inputMint || parsed.outputMint !== input.outputMint || parsed.inAmount !== input.amountAtomic.toString()) {
    throw new Error('quote_echo_mismatch');
  }
  for (let i = 0; i < parsed.routePlan.length; i++) {
    const step = parsed.routePlan[i]!.swapInfo;
    if (i === 0 && step.inputMint !== input.inputMint) throw new Error('route_discontinuous');
    if (i > 0 && parsed.routePlan[i - 1]!.swapInfo.outputMint !== step.inputMint) throw new Error('route_discontinuous');
    if (i === parsed.routePlan.length - 1 && step.outputMint !== input.outputMint) throw new Error('route_discontinuous');
  }
  return {
    inputMint: parsed.inputMint,
    outputMint: parsed.outputMint,
    inAmount: BigInt(parsed.inAmount),
    outAmount: BigInt(parsed.outAmount),
    slippageBps: parsed.slippageBps,
    priceImpactPct: Number(parsed.priceImpactPct),
    routePlan: parsed.routePlan.map((step) => ({
      inputMint: step.swapInfo.inputMint,
      outputMint: step.swapInfo.outputMint,
    })),
    parsed,
  };
}

export async function buildTradingSwapTransaction(input: {
  quote: JupiterQuote;
  userPublicKey: string;
  maxPriorityFeeLamports: bigint;
  fetchImpl?: typeof fetch;
}): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight: number; recentBlockhash: string }> {
  if (input.maxPriorityFeeLamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('priority_fee_too_large');
  const body = {
    quoteResponse: input.quote.parsed,
    userPublicKey: input.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        priorityLevel: 'high',
        maxLamports: Number(input.maxPriorityFeeLamports),
        global: false,
      },
    },
  };
  const response = await (input.fetchImpl ?? fetch)(`${resolveTradingJupiterBaseUrl()}/swap/v1/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...requestHeaders() },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`swap_http_${response.status}`);
  const parsed = swapResponseSchema.parse(await response.json());
  const transaction = VersionedTransaction.deserialize(Buffer.from(parsed.swapTransaction, 'base64'));
  return {
    transaction,
    lastValidBlockHeight: parsed.lastValidBlockHeight,
    recentBlockhash: transaction.message.recentBlockhash,
  };
}
