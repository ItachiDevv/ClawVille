import { expect, test } from 'bun:test';
import {Keypair} from '@solana/web3.js';
import {solanaRpcFixture} from './purchase-solana-testhelpers';
test('fixed RPC checks genesis, exact lifetime and actual SPL account layouts', async () => {
  const {rpc, state, artifact} = solanaRpcFixture(); expect((await rpc.lifetime()).blockhash).toBe(artifact.blockhash);
  await rpc.accounts(artifact); await rpc.valid(artifact); expect(state.calls.includes('getMultipleAccounts')).toBe(true);
  state.height = 201; await expect(rpc.valid(artifact)).rejects.toThrow();
  state.height = 150; state.valid = false; await expect(rpc.valid(artifact)).rejects.toThrow();
  state.valid = true; state.missing = true; await expect(rpc.accounts(artifact)).rejects.toMatchObject({code: 'associated_token_account_required'});
  state.missing = false; state.token2022 = true; await expect(rpc.accounts(artifact)).rejects.toThrow();
  state.token2022 = false; state.genesis = Keypair.generate().publicKey.toBase58(); await expect(rpc.lifetime()).rejects.toThrow();
  expect(state.calls).not.toContain('sendTransaction');
});
