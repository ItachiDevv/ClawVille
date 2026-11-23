import {createHash} from 'node:crypto';
import {z} from 'zod';
import {SolanaBuyerRpc} from './purchase-solana-rpc';
import {SolanaBuyerReceipts, type SolanaBuyerReceiptEvidence} from './purchase-solana-receipts';
import {solanaBuyerSignature} from './purchase-solana-policy';
import {decodeSolanaBuyerTransaction, verifySolanaBuyerTransaction, type SolanaBuyerArtifact} from './purchase-solana-transaction';

const integer = z.number().int().nonnegative().safe();
const cursorSchema = z.object({version: z.literal(1), messageHash: z.string().regex(/^[a-f0-9]{64}$/),
  payerBefore: solanaBuyerSignature.nullable(), sourceBefore: solanaBuyerSignature.nullable(), payerDone: z.boolean(), sourceDone: z.boolean()}).strict();
const historySchema = z.array(z.object({signature: solanaBuyerSignature, slot: integer, err: z.union([z.null(),z.record(z.unknown()),z.string().max(1000)]), memo: z.string().max(2000).nullable(),
  blockTime: integer.nullable(), confirmationStatus: z.enum(['confirmed','finalized']).nullable()}).strict()).max(25);
const candidateSchema = z.object({slot: integer, transaction: z.tuple([z.string().max(1644),z.literal('base64')])}).passthrough();
export type SolanaDiscoveryCursor = z.infer<typeof cursorSchema>;
export interface SolanaDiscoveryObservation {
  state: 'incomplete'|'not_found'|'unavailable'|'ambiguous'|'payment_observed'; checkedAt: string; scannedTransactions: number; hasMore: boolean;
}
export interface SolanaDiscoveryResult {cursor: SolanaDiscoveryCursor; observation: SolanaDiscoveryObservation; payment?: SolanaBuyerReceiptEvidence}
/** No caller-selected address, URL, signature, transaction, or payment operation enters this scan. */
export class SolanaBuyerDiscovery {
  constructor(private readonly rpc = new SolanaBuyerRpc(), private readonly receipts = new SolanaBuyerReceipts(rpc)) {}
  async scan(artifact: SolanaBuyerArtifact, rawCursor: unknown): Promise<SolanaDiscoveryResult> {
    const initial: SolanaDiscoveryCursor = {version:1,messageHash:artifact.messageHash,payerBefore:null,sourceBefore:null,payerDone:false,sourceDone:false};
    const original = rawCursor === null ? initial : cursorSchema.parse(rawCursor);
    if(original.messageHash!==artifact.messageHash)throw new Error('Discovery cursor belongs to another message');
    const cursor = {...(original.payerDone&&original.sourceDone?initial:original)};
    let scanned = 0, pages = 0, state: SolanaDiscoveryObservation['state'] = 'incomplete';
    const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),15000), seen = new Set<string>(), matches = new Map<string,SolanaBuyerReceiptEvidence>();
    try {
      await this.rpc.genesis(controller.signal);
      for(const [address,beforeKey,doneKey] of [[artifact.payer,'payerBefore','payerDone'],[artifact.sourceAta,'sourceBefore','sourceDone']] as const){
        if(cursor[doneKey])continue;
        while(pages<4&&scanned<12&&!cursor[doneKey]){
          controller.signal.throwIfAborted();
          const before = cursor[beforeKey];
          const page = historySchema.parse(await this.rpc.read('getSignaturesForAddress',[address,{commitment:'finalized',minContextSlot:artifact.contextSlot,limit:25,...(before?{before}:{})}],controller.signal));pages++;
          if(new Set(page.map(row=>row.signature)).size!==page.length||page.some((row,index)=>index>0&&row.slot>page[index-1]!.slot)||page.some(row=>row.signature===before))throw new Error('Invalid history page');
          if(page.length===0){cursor[doneKey]=true;break;}
          for(const row of page){
            controller.signal.throwIfAborted();if(scanned>=12)break;
            if(row.slot<artifact.contextSlot){cursor[doneKey]=true;break;}
            if(seen.has(row.signature)){cursor[beforeKey]=row.signature;continue;}
            if(row.confirmationStatus!=='finalized')throw new Error('History finality unavailable');
            if(row.err===null){
              const candidate = candidateSchema.parse(await this.rpc.read('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}],controller.signal));
              if(candidate.slot!==row.slot)throw new Error('History slot changed');
              const tx = decodeSolanaBuyerTransaction(candidate.transaction[0]);
              if(createHash('sha256').update(tx.message.serialize()).digest('hex')===artifact.messageHash){
                // Matching messages must also carry the pinned fee-payer and external payer signatures.
                verifySolanaBuyerTransaction(artifact,candidate.transaction[0],true);
                const proof = await this.receipts.verify(row.signature,artifact,'payment',undefined,'finalized',controller.signal);
                if(proof.blockNumber!==String(row.slot))throw new Error('Payment slot changed');matches.set(proof.transaction,proof);
              }
            }
            seen.add(row.signature);scanned++;cursor[beforeKey]=row.signature;
          }
          if(page.length<25&&scanned<12)cursor[doneKey]=true;
          if(matches.size>0||scanned>=12)break;
        }
        if(matches.size>0)break;
      }
      state = matches.size>1?'ambiguous':matches.size===1?'payment_observed':cursor.payerDone&&cursor.sourceDone?'not_found':'incomplete';
    } catch {state='unavailable';Object.assign(cursor,original);}
    finally{clearTimeout(timer);controller.abort();}
    return {cursor,observation:{state,checkedAt:new Date().toISOString(),scannedTransactions:scanned,hasMore:!(cursor.payerDone&&cursor.sourceDone)},...(state==='payment_observed'?{payment:[...matches.values()][0]}:{})};
  }
}
