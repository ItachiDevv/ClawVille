import { z } from 'zod';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BrainchainPurchaseError } from './purchase-policy';
import { SOLANA_BUYER_LANE as L, solanaBuyerAddress } from './purchase-solana-policy';
import type { SolanaBuyerArtifact } from './purchase-solana-transaction';

const integer = z.number().int().nonnegative().safe();
export class SolanaBuyerRpc {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  /** Fixed read-only RPC. There is no sendTransaction operation. */
  async read(method: 'getGenesisHash'|'getLatestBlockhash'|'getBlockHeight'|'isBlockhashValid'|'getMultipleAccounts'|'getTransaction'|'getBlock'|'getSignaturesForAddress', params: unknown[] = [], signal?: AbortSignal): Promise<unknown> {
    if (!['getGenesisHash','getLatestBlockhash','getBlockHeight','isBlockhashValid','getMultipleAccounts','getTransaction','getBlock','getSignaturesForAddress'].includes(method)) throw new BrainchainPurchaseError('invalid_request');
    if(signal?.aborted)throw new BrainchainPurchaseError('receipt_unavailable');
    const controller = new AbortController(); let rejectStopped: ((reason: unknown) => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_, reject) => { rejectStopped=reject; timer = setTimeout(() => { controller.abort(); reject(new BrainchainPurchaseError('receipt_unavailable')); }, 5000); });
    const abort=()=>{controller.abort();rejectStopped?.(new BrainchainPurchaseError('receipt_unavailable'));};signal?.addEventListener('abort',abort,{once:true});
    const operation = async () => {
      const response = await this.fetcher(L.rpc, {method: 'POST', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
      if (controller.signal.aborted || !response.ok || !response.headers.get('content-type')?.startsWith('application/json') || response.redirected || response.url && response.url !== L.rpc || !response.body) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', cancel, {once: true});
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262144) { await reader.cancel(); throw new Error(); } chunks.push(part.value); } }
      finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
      const result = z.object({jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown()}).strict().parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))));
      return result.result;
    };
    try { return await Promise.race([operation(), stopped]); } catch { throw new BrainchainPurchaseError('receipt_unavailable'); } finally { signal?.removeEventListener('abort',abort);clearTimeout(timer); controller.abort(); }
  }
  async genesis(signal?:AbortSignal): Promise<void> { if (await this.read('getGenesisHash',[],signal) !== L.genesisHash) throw new BrainchainPurchaseError('unsupported_payment_lane'); }
  async lifetime() {
    await this.genesis();
    const value = z.object({context: z.object({slot: integer}), value: z.object({blockhash: solanaBuyerAddress, lastValidBlockHeight: integer})}).parse(await this.read('getLatestBlockhash', [{commitment: 'confirmed'}]));
    return {blockhash: value.value.blockhash, lastValidBlockHeight: value.value.lastValidBlockHeight, contextSlot: value.context.slot};
  }
  async valid(artifact: SolanaBuyerArtifact): Promise<void> {
    await this.genesis();
    const status = z.object({context: z.object({slot: integer}), value: z.boolean()}).parse(await this.read('isBlockhashValid', [artifact.blockhash, {commitment: 'confirmed', minContextSlot: artifact.contextSlot}]));
    const height = integer.parse(await this.read('getBlockHeight', [{commitment: 'confirmed', minContextSlot: artifact.contextSlot}]));
    if (!status.value || status.context.slot < artifact.contextSlot || height > artifact.lastValidBlockHeight) throw new BrainchainPurchaseError('order_conflict');
  }
  async accounts(artifact: SolanaBuyerArtifact): Promise<void> {
    await this.genesis();
    const account = z.object({owner: z.literal(TOKEN_PROGRAM_ID.toBase58()), executable: z.literal(false), data: z.tuple([z.string().max(1000), z.literal('base64')])}).passthrough();
    const result = z.object({context: z.object({slot: integer}), value: z.tuple([account.nullable(), account.nullable(), account.nullable()])}).parse(await this.read('getMultipleAccounts', [[L.token, artifact.sourceAta, artifact.destinationAta], {encoding: 'base64', commitment: 'confirmed', minContextSlot: artifact.contextSlot}]));
    if (result.context.slot < artifact.contextSlot) throw new BrainchainPurchaseError('receipt_unavailable');
    if (result.value.some(value => value === null)) throw new BrainchainPurchaseError('associated_token_account_required');
    try {
      const mintBytes = Buffer.from(result.value[0]!.data[0], 'base64'); if (mintBytes.length !== MintLayout.span) throw new Error();
      const mint = MintLayout.decode(mintBytes); if (mint.decimals !== 6 || !mint.isInitialized) throw new Error();
      for (const [index, owner] of [[1, artifact.payer], [2, L.recipient]] as const) {
        const bytes = Buffer.from(result.value[index]!.data[0], 'base64'); if (bytes.length !== AccountLayout.span) throw new Error();
        const token = AccountLayout.decode(bytes);
        if (token.mint.toBase58() !== L.token || token.owner.toBase58() !== owner || token.state !== 1 || token.delegateOption !== 0 || token.closeAuthorityOption !== 0
          || index === 1 && token.amount < BigInt(L.amountAtomic)) throw new Error();
      }
    } catch { throw new BrainchainPurchaseError('invalid_proof'); }
  }
}
