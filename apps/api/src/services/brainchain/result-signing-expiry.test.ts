import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import { test, expect } from 'bun:test';
import { ResultSignatureCoordinator } from './result-signing';
import { freezeResultSignatureIntent, resultSignatureClaimHash } from './result-signing-policy';
import { BRAINCHAIN_CONTRACTS } from './contracts';
test('result signer grant expiry is checked after the recovery wrapper final evidence wait', async () => {
  const id = '11111111-1111-4111-8111-111111111111', worker = `0x${'1'.repeat(40)}`, resultHash = `0x${'a'.repeat(64)}`;
  const row = { id, binding_id: id, result_hash: resultHash };
  const task = { address: worker, board_address: BRAINCHAIN_CONTRACTS.testnet.contracts.board, task_id: '1' };
  const intent = freezeResultSignatureIntent({ domain: 'brainchain-result-v2', chainId: 274630, resultId: id, board: task.board_address, task: '1', hash: resultHash, worker });
  const start=Date.now();let now=start,reads=0;
  const reader=fixtureConfiguredAuthorityReader();
  const grant = { authority_policy_version:CONFIGURED_AUTHORITY_VERSION,authority_policy_digest:CONFIGURED_AUTHORITY_DIGEST,observation_policy: 'legacy-depth12-age120-v1', expires_at: new Date(start+10000), signer_ref: 'brainchain-testnet:fixture', request_hash: resultSignatureClaimHash('brainchain-testnet:fixture', intent) };
  const tx = async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('SELECT a.*')) return [grant];
    if (query.includes('SELECT 1')) return now < grant.expires_at.getTime() ? [{}] : [];
    return [];
  };
  Object.assign(tx,{typed:(value:unknown)=>value});
  const coordinator = new ResultSignatureCoordinator({} as never, {} as never, {} as never,undefined,async input=>{reads++;return reader(input);});
  (coordinator as any).delivery = {
    readInTransaction: async () => row,
    withCurrentResult: async (_tx: unknown, _avatar: unknown, _result: unknown, callback: Function) => {
      const answer = await callback(row, task);
      // Model the recovery wrapper's final external evidence read after its action callback.
      now = start+20000;
      return answer;
    },
  };
  await expect((coordinator as any).authority(tx, id, id, id)).rejects.toThrow('Result authority expired after recovery verification');
  expect(reads).toBe(1);
});

