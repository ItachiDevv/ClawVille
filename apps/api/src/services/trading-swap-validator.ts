import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  MessageV0,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TRADE_MINTS } from '@clawville/shared';

export type LegMode = 'token' | 'native-sol';
export interface SwapLeg {
  mint: PublicKey;
  tokenProgram: PublicKey;
  ata: PublicKey;
  mode: LegMode;
  direction: 'debit' | 'credit';
}
export type SwapShape = 'token-token' | 'sol-token' | 'token-sol';

const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const WSOL = new PublicKey(TRADE_MINTS.WSOL);
const ROUTE = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);
const SHARED_ROUTE = Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]);
const MAX_COMPUTE_UNITS = 1_400_000n;
const BASE_FEE_PER_SIGNATURE_LAMPORTS = 5_000n;

function deriveAta(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), program.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function legError(input: { wallet: PublicKey; inputLeg: SwapLeg; outputLeg: SwapLeg; shape: SwapShape }): string | null {
  const { wallet, inputLeg, outputLeg, shape } = input;
  const staticPrograms = new Map<string, PublicKey>([
    [TRADE_MINTS.WSOL, TOKEN_PROGRAM_ID],
    [TRADE_MINTS.USDC, TOKEN_PROGRAM_ID],
    [TRADE_MINTS.ANSEM, TOKEN_2022_PROGRAM_ID],
    [TRADE_MINTS.CLAWVILLE, TOKEN_2022_PROGRAM_ID],
  ]);
  if (inputLeg.direction !== 'debit' || outputLeg.direction !== 'credit') return 'leg_direction';
  if (inputLeg.mint.equals(outputLeg.mint)) return 'duplicate_mint';
  const expectedShape: SwapShape | null = inputLeg.mode === 'native-sol'
    ? (outputLeg.mode === 'token' ? 'sol-token' : null)
    : (outputLeg.mode === 'native-sol' ? 'token-sol' : 'token-token');
  if (!expectedShape || expectedShape !== shape) return expectedShape ? 'shape_mismatch' : 'sol_sol';
  for (const leg of [inputLeg, outputLeg]) {
    const expectedProgram = staticPrograms.get(leg.mint.toBase58());
    if (!expectedProgram) return 'mint_not_static';
    if (!leg.tokenProgram.equals(expectedProgram)) return 'token_program';
    if (leg.mode === 'native-sol') {
      if (!leg.mint.equals(WSOL) || !leg.tokenProgram.equals(TOKEN_PROGRAM_ID)) return 'native_leg_mismatch';
    } else {
      if (!leg.tokenProgram.equals(TOKEN_PROGRAM_ID) && !leg.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return 'token_program';
      if (!leg.ata.equals(deriveAta(wallet, leg.mint, leg.tokenProgram))) return 'ata_mismatch';
    }
  }
  return null;
}

function decodeRoute(data: Buffer): { kind: 'route' | 'shared_accounts_route'; inAmount: bigint; quotedOut: bigint; slippageBps: number; minOut: bigint } | null {
  let header = 0;
  let kind: 'route' | 'shared_accounts_route';
  if (data.subarray(0, 8).equals(ROUTE)) { header = 8; kind = 'route'; }
  else if (data.subarray(0, 8).equals(SHARED_ROUTE)) { header = 9; kind = 'shared_accounts_route'; }
  else return null;
  if (data.length < header + 23) return null;
  const steps = data.readUInt32LE(header);
  if (steps < 1 || steps > 4) return null;
  const offset = data.length - 19;
  const inAmount = data.readBigUInt64LE(offset);
  const quotedOut = data.readBigUInt64LE(offset + 8);
  const slippageBps = data.readUInt16LE(offset + 16);
  if (data[offset + 18] !== 0 || slippageBps > 10_000) return null;
  const minOut = (quotedOut * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n;
  return { kind, inAmount, quotedOut, slippageBps, minOut };
}

export type TradingSwapInspection =
  | { ok: true; minimumOutAmount: bigint; quotedOutAmount: bigint; slippageBps: number; priorityFeeLamports: bigint; derivedWsolAccounts: PublicKey[] }
  | { ok: false; detail: string };

export function inspectTradingSwapTransaction(input: {
  transaction: VersionedTransaction;
  wallet: PublicKey;
  inputAmount: bigint;
  minimumOutAmount: bigint;
  priorityFeeLamports: bigint;
  inputLeg?: SwapLeg;
  outputLeg?: SwapLeg;
  shape?: SwapShape;
  quotedOutAmount?: bigint;
  slippageBps?: number;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}): TradingSwapInspection {
  const tx = input.transaction;
  if (tx.message.version !== 0) return { ok: false, detail: 'message_not_v0' };
  const message = tx.message as MessageV0;
  if (message.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1) return { ok: false, detail: 'required_signer_count' };
  if (!message.staticAccountKeys[0]?.equals(input.wallet)) return { ok: false, detail: 'payer_mismatch' };
  if (tx.signatures.some((sig) => sig.some((byte) => byte !== 0))) return { ok: false, detail: 'preexisting_signature' };
  let keys: ReturnType<MessageV0['getAccountKeys']>;
  try {
    keys = message.getAccountKeys({ addressLookupTableAccounts: input.addressLookupTableAccounts ?? [] });
  } catch {
    return { ok: false, detail: 'lookup_resolution' };
  }
  const keyAt = (index: number) => keys.get(index) ?? null;
  let route: ReturnType<typeof decodeRoute> = null;
  let computeLimit: bigint | null = null;
  let computePrice = 0n;
  const derivedWsolAccounts: PublicKey[] = [];
  for (const ix of message.compiledInstructions) {
    const program = keyAt(ix.programIdIndex);
    if (!program) return { ok: false, detail: 'program_index' };
    const data = Buffer.from(ix.data);
    const accounts = Array.from(ix.accountKeyIndexes);
    if (program.equals(ComputeBudgetProgram.programId)) {
      if (data[0] === 2 && data.length === 5) computeLimit = BigInt(data.readUInt32LE(1));
      else if (data[0] === 3 && data.length === 9) computePrice = data.readBigUInt64LE(1);
      else if (![1, 4].includes(data[0] ?? -1)) return { ok: false, detail: 'compute_budget_variant' };
      continue;
    }
    if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const ata = keyAt(accounts[1]!);
      const owner = keyAt(accounts[2]!);
      const mint = keyAt(accounts[3]!);
      const tokenProgram = keyAt(accounts[5]!);
      if (data.length !== 1 || data[0] !== 1 || accounts.length !== 6 || !ata || !owner?.equals(input.wallet) || !mint || !tokenProgram) {
        return { ok: false, detail: 'ata_setup_mismatch' };
      }
      if (!ata.equals(deriveAta(input.wallet, mint, tokenProgram))) return { ok: false, detail: 'ata_setup_mismatch' };
      if (mint.equals(WSOL)) derivedWsolAccounts.push(ata);
      continue;
    }
    if (program.equals(SystemProgram.programId) || program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) continue;
    if (!program.equals(JUPITER) || route) return { ok: false, detail: 'outer_program' };
    route = decodeRoute(data);
    if (!route) return { ok: false, detail: 'jupiter_instruction_decode' };
    if (input.inputLeg && input.outputLeg && input.shape) {
      const legs = validateTradingLegs({
        wallet: input.wallet,
        inputLeg: input.inputLeg,
        outputLeg: input.outputLeg,
        shape: input.shape,
      });
      if (!legs.ok) return legs;
      const layout = route.kind === 'route'
        ? { minimumAccounts: 7, authority: 1, source: 2, destination: 3, sourceMint: null, destinationMint: 5 }
        : { minimumAccounts: 9, authority: 2, source: 3, destination: 6, sourceMint: 7, destinationMint: 8 };
      if (accounts.length < layout.minimumAccounts) return { ok: false, detail: 'route_account_layout' };
      const accountAt = (position: number): PublicKey | null => keyAt(accounts[position]!);
      if (!accountAt(layout.authority)?.equals(input.wallet)) return { ok: false, detail: 'route_authority_mismatch' };
      const source = accountAt(layout.source);
      const destination = accountAt(layout.destination);
      const legAccountMatches = (leg: SwapLeg, actual: PublicKey | null): boolean => {
        if (!actual) return false;
        if (leg.mode === 'token') return actual.equals(leg.ata);
        return actual.equals(leg.ata) || derivedWsolAccounts.some((account) => account.equals(actual));
      };
      if (!legAccountMatches(input.inputLeg, source) || !legAccountMatches(input.outputLeg, destination)) {
        return { ok: false, detail: 'route_leg_account_mismatch' };
      }
      if (!message.isAccountWritable(accounts[layout.source]!) || !message.isAccountWritable(accounts[layout.destination]!)) {
        return { ok: false, detail: 'route_leg_account_readonly' };
      }
      if (layout.sourceMint !== null && !accountAt(layout.sourceMint)?.equals(input.inputLeg.mint)) {
        return { ok: false, detail: 'route_input_mint_mismatch' };
      }
      if (!accountAt(layout.destinationMint)?.equals(input.outputLeg.mint)) {
        return { ok: false, detail: 'route_output_mint_mismatch' };
      }
      if (route.kind === 'route') {
        const tokenProgram = accountAt(0);
        if (!tokenProgram?.equals(input.inputLeg.tokenProgram) || !tokenProgram.equals(input.outputLeg.tokenProgram)) {
          return { ok: false, detail: 'route_token_program_mismatch' };
        }
      } else {
        const legacyProgram = accountAt(0);
        const token2022Program = accounts.length > 10 ? accountAt(10) : null;
        const hasProgram = (program: PublicKey) => program.equals(TOKEN_PROGRAM_ID)
          ? legacyProgram?.equals(program) === true
          : token2022Program?.equals(program) === true;
        if (!hasProgram(input.inputLeg.tokenProgram) || !hasProgram(input.outputLeg.tokenProgram)) {
          return { ok: false, detail: 'route_token_program_mismatch' };
        }
      }
    }
  }
  if (!route || route.inAmount !== input.inputAmount) return { ok: false, detail: 'jupiter_amount_binding' };
  if (route.quotedOut <= 0n || route.minOut <= 0n) return { ok: false, detail: 'minimum_out_non_positive' };
  if (input.quotedOutAmount !== undefined && route.quotedOut !== input.quotedOutAmount) return { ok: false, detail: 'quoted_out_mismatch' };
  if (input.slippageBps !== undefined && route.slippageBps !== input.slippageBps) return { ok: false, detail: 'slippage_mismatch' };
  if (route.minOut !== input.minimumOutAmount) return { ok: false, detail: 'minimum_out_mismatch' };
  if (computeLimit !== null && computeLimit > MAX_COMPUTE_UNITS) return { ok: false, detail: 'compute_limit' };
  if (computePrice > 0n && computeLimit === null) return { ok: false, detail: 'priority_fee_unbounded' };
  const priority = computePrice > 0n && computeLimit !== null
    ? (computePrice * computeLimit + 999_999n) / 1_000_000n
    : 0n;
  const totalFee = BASE_FEE_PER_SIGNATURE_LAMPORTS * BigInt(message.header.numRequiredSignatures) + priority;
  if (totalFee > input.priorityFeeLamports) return { ok: false, detail: 'priority_fee' };
  return {
    ok: true,
    minimumOutAmount: route.minOut,
    quotedOutAmount: route.quotedOut,
    slippageBps: route.slippageBps,
    priorityFeeLamports: totalFee,
    derivedWsolAccounts,
  };
}

interface Snap { amount: bigint; lamports: bigint; exists: boolean }
function tokenSnap(info: { owner: PublicKey | string; data: Buffer; lamports: number } | null, leg: SwapLeg, wallet: PublicKey): Snap | null {
  if (!info) return { amount: 0n, lamports: 0n, exists: false };
  const owner = typeof info.owner === 'string' ? new PublicKey(info.owner) : info.owner;
  if (!owner.equals(leg.tokenProgram) || info.data.length < 165 || !info.data.subarray(0, 32).equals(leg.mint.toBuffer()) || !info.data.subarray(32, 64).equals(wallet.toBuffer()) || info.data[108] !== 1) return null;
  return { amount: info.data.readBigUInt64LE(64), lamports: BigInt(info.lamports), exists: true };
}

function walletControlledTokenLamports(
  info: { owner: PublicKey | string; data: Buffer; lamports: number } | null,
  wallet: PublicKey,
): bigint {
  if (!info || !Number.isSafeInteger(info.lamports) || info.lamports < 0) return 0n;
  let owner: PublicKey;
  try { owner = typeof info.owner === 'string' ? new PublicKey(info.owner) : info.owner; }
  catch { return 0n; }
  const tokenAccount = owner.equals(TOKEN_PROGRAM_ID)
    ? info.data.length === 165
    : owner.equals(TOKEN_2022_PROGRAM_ID)
      && info.data.length !== 355
      && (info.data.length === 165 || (info.data.length > 165 && info.data[165] === 2));
  if (!tokenAccount || info.data.length < 165 || !info.data.subarray(32, 64).equals(wallet.toBuffer()) || info.data[108] !== 1) return 0n;
  if (info.data.readUInt32LE(129) === 1 && !info.data.subarray(133, 165).equals(wallet.toBuffer())) return 0n;
  return BigInt(info.lamports);
}

export async function validateTradingSwapSimulation(input: {
  transaction: VersionedTransaction;
  wallet: PublicKey;
  connection: Connection;
  inputLeg: SwapLeg;
  outputLeg: SwapLeg;
  shape: SwapShape;
  inputAmount: bigint;
  minimumOutAmount: bigint;
  priorityFeeLamports: bigint;
  transactionDerivedWsolAccounts: readonly PublicKey[];
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}): Promise<{ ok: true; postTransactionWalletLamports: bigint } | { ok: false; detail: string }> {
  const inconsistent = legError(input);
  if (inconsistent) return { ok: false, detail: inconsistent };
  const inspection = inspectTradingSwapTransaction(input);
  if (!inspection.ok) return inspection;
  const expectedWsol = new Set(input.transactionDerivedWsolAccounts.map((key) => key.toBase58()));
  if (inspection.derivedWsolAccounts.some((key) => !expectedWsol.has(key.toBase58()))) return { ok: false, detail: 'wsol_account_mismatch' };

  const message = input.transaction.message as MessageV0;
  let keys: ReturnType<MessageV0['getAccountKeys']>;
  try { keys = message.getAccountKeys({ addressLookupTableAccounts: input.addressLookupTableAccounts ?? [] }); }
  catch { return { ok: false, detail: 'lookup_resolution' }; }
  // Three of the four recorded routes use a transaction-created wSOL account.
  // Keep those accounts in the exact permitted set for the common route path.
  const permitted = new Set([input.wallet.toBase58(), input.inputLeg.ata.toBase58(), input.outputLeg.ata.toBase58(), ...expectedWsol]);
  const writable: PublicKey[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys.get(i);
    if (key && message.isAccountWritable(i)) writable.push(key);
  }
  const specs = [input.inputLeg, input.outputLeg].filter((leg) => leg.mode === 'token');
  const snapshotKeys: PublicKey[] = [...specs.map((leg) => leg.ata), input.wallet];
  const seen = new Set(snapshotKeys.map((key) => key.toBase58()));
  for (const key of writable) {
    if (!seen.has(key.toBase58())) {
      seen.add(key.toBase58());
      snapshotKeys.push(key);
    }
  }
  const addresses = snapshotKeys.map((key) => key.toBase58());
  const pre: Awaited<ReturnType<Connection['getMultipleAccountsInfo']>> = [];
  try {
    for (let offset = 0; offset < snapshotKeys.length; offset += 100) {
      const chunk = snapshotKeys.slice(offset, offset + 100);
      const rows = await input.connection.getMultipleAccountsInfo(chunk, 'confirmed');
      if (rows.length !== chunk.length) return { ok: false, detail: 'simulation_pre_snapshot_shape' };
      pre.push(...rows);
    }
  }
  catch { return { ok: false, detail: 'simulation_pre_snapshot' }; }
  for (let i = 0; i < snapshotKeys.length; i++) {
    const info = pre[i];
    if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) || info.data.length < 165) continue;
    const authority = new PublicKey(info.data.subarray(32, 64));
    if (authority.equals(input.wallet) && !permitted.has(snapshotKeys[i]!.toBase58())) return { ok: false, detail: 'unexpected_wallet_token_account' };
  }
  let exactFee: bigint;
  try {
    const fee = await input.connection.getFeeForMessage(message, 'confirmed');
    if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) return { ok: false, detail: 'simulation_fee_unavailable' };
    exactFee = BigInt(fee.value);
  } catch { return { ok: false, detail: 'simulation_fee_unavailable' }; }
  if (exactFee !== inspection.priorityFeeLamports) return { ok: false, detail: 'simulation_fee_mismatch' };
  let sim;
  try {
    sim = await input.connection.simulateTransaction(input.transaction, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses } });
  } catch { return { ok: false, detail: 'simulation_rpc' }; }
  if (sim.value.err) return { ok: false, detail: 'simulation_error' };
  if (!sim.value.accounts || sim.value.accounts.length !== addresses.length) return { ok: false, detail: 'simulation_post_snapshot_shape' };
  const snapshots = specs.map((leg, i) => {
    const before = tokenSnap(pre[i] ? { owner: pre[i]!.owner, data: Buffer.from(pre[i]!.data), lamports: pre[i]!.lamports } : null, leg, input.wallet);
    const wire = sim.value.accounts![i];
    const after = wire && Array.isArray(wire.data) ? tokenSnap({ owner: wire.owner, data: Buffer.from(wire.data[0], 'base64'), lamports: wire.lamports }, leg, input.wallet) : tokenSnap(null, leg, input.wallet);
    return { leg, before, after };
  });
  if (snapshots.some((s) => !s.before || !s.after)) return { ok: false, detail: 'simulation_token_invalid' };
  const source = snapshots.find((s) => s.leg.direction === 'debit');
  if (source && source.before!.amount - source.after!.amount > input.inputAmount) return { ok: false, detail: 'simulation_source_over_debit' };
  const destination = snapshots.find((s) => s.leg.direction === 'credit');
  if (destination && destination.after!.amount - destination.before!.amount < input.minimumOutAmount) return { ok: false, detail: 'simulation_destination_under_credit' };

  const walletIndex = specs.length;
  const preWallet = pre[walletIndex];
  const postWallet = sim.value.accounts[walletIndex];
  if (!preWallet || !postWallet || postWallet.owner !== SystemProgram.programId.toBase58()) return { ok: false, detail: 'simulation_wallet_balance_missing' };
  let ownedPre = BigInt(preWallet.lamports);
  let ownedPost = BigInt(postWallet.lamports);
  for (let index = 0; index < snapshotKeys.length; index++) {
    if (index === walletIndex) continue;
    const before = pre[index];
    if (before) ownedPre += walletControlledTokenLamports({ owner: before.owner, data: Buffer.from(before.data), lamports: before.lamports }, input.wallet);
    const after = sim.value.accounts[index];
    if (after && Array.isArray(after.data) && after.data[1] === 'base64') {
      const controlled = walletControlledTokenLamports({ owner: after.owner, data: Buffer.from(after.data[0], 'base64'), lamports: after.lamports }, input.wallet);
      ownedPost += controlled;
      if (controlled > 0n && !permitted.has(snapshotKeys[index]!.toBase58())) return { ok: false, detail: 'unexpected_wallet_token_account' };
    }
  }
  const ownedDecrease = ownedPre - ownedPost;
  if (input.shape === 'sol-token' && ownedDecrease > input.inputAmount + exactFee) return { ok: false, detail: 'simulation_wallet_lamport_delta' };
  if (input.shape !== 'sol-token' && ownedDecrease > exactFee) return { ok: false, detail: 'simulation_wallet_lamport_delta' };
  if (input.shape === 'token-sol' && ownedPost - ownedPre + exactFee < input.minimumOutAmount) return { ok: false, detail: 'simulation_native_min_out' };
  return { ok: true, postTransactionWalletLamports: BigInt(postWallet.lamports) };
}

export function validateTradingLegs(input: { wallet: PublicKey; inputLeg: SwapLeg; outputLeg: SwapLeg; shape: SwapShape }): { ok: true } | { ok: false; detail: string } {
  const detail = legError(input);
  return detail ? { ok: false, detail } : { ok: true };
}
