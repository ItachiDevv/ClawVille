import { Keypair, PublicKey } from '@solana/web3.js';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SolanaBuyerRpc } from './purchase-solana-rpc';
import { buildSolanaBuyerArtifact, type SolanaBuyerArtifact } from './purchase-solana-transaction';
import { SOLANA_BUYER_LANE as L } from './purchase-solana-policy';
export function solanaRpcFixture(artifact?: SolanaBuyerArtifact) {
  const state = {height: 150, valid: true, genesis: L.genesisHash as string, missing: false, token2022: false, calls: [] as string[]};
  const payer = artifact?.payer ?? Keypair.generate().publicKey.toBase58();
  const lifetime = {blockhash: artifact?.blockhash ?? Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200, contextSlot: 100};
  const a = artifact ?? buildSolanaBuyerArtifact(payer, lifetime);
  const account = (owner: string) => {
    const data = Buffer.alloc(AccountLayout.span); AccountLayout.encode({mint: new PublicKey(L.token), owner: new PublicKey(owner), amount: 2000000n, delegateOption: 0,
      delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default}, data);
    return {owner: state.token2022 ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : TOKEN_PROGRAM_ID.toBase58(), executable: false, data: [data.toString('base64'), 'base64']};
  };
  const mintData = Buffer.alloc(MintLayout.span); MintLayout.encode({mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default}, mintData);
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== L.rpc) throw new Error('Unexpected RPC');
    const request = JSON.parse(String(init?.body)) as {method: string}; state.calls.push(request.method); let result: unknown;
    if (request.method === 'getGenesisHash') result = state.genesis;
    else if (request.method === 'getLatestBlockhash') result = {context: {slot: 100}, value: {blockhash: lifetime.blockhash, lastValidBlockHeight: 200}};
    else if (request.method === 'getBlockHeight') result = state.height;
    else if (request.method === 'isBlockhashValid') result = {context: {slot: 100}, value: state.valid};
    else if (request.method === 'getMultipleAccounts') result = {context: {slot: 100}, value: [{owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, data: [mintData.toString('base64'), 'base64']}, state.missing ? null : account(payer), account(L.recipient)]};
    else throw new Error('Unexpected RPC method');
    return Response.json({jsonrpc: '2.0', id: 1, result});
  }) as typeof fetch;
  return {state, artifact: a, rpc: new SolanaBuyerRpc(fetcher), fetcher};
}
