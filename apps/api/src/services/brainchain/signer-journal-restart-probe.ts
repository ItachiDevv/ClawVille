/** Fixture-only, two-process persistence probe. Contains no key and no valid transaction. */
import assert from 'node:assert/strict';
import {createProtectedSignerJournal} from './signer-payload-store';

const phase=process.argv[2];
const directory=process.env.BRAINCHAIN_SIGNER_STORE_TEST_ROOT;
if(!directory||!['write','read'].includes(phase??''))throw Error('Private fixture directory and write/read phase required');
const journal=await createProtectedSignerJournal(directory,10001);
const operation='12345678-1234-4234-8234-123456789abc';
const intentHash='a'.repeat(64);
if(phase==='write'){
  assert.equal(await journal.claimKeyUse(operation,intentHash),true);
  const reference=await journal.putIfAbsent(operation,'0x0201');
  assert.deepEqual(await journal.findByOperation(operation),{reference,bytes:'0x0201'});
}else{
  assert.equal(await journal.claimKeyUse(operation,intentHash),false);
  const capture=await journal.findByOperation(operation);
  assert.ok(capture);
  assert.equal(capture.bytes,'0x0201');
  assert.equal(await journal.get(capture.reference),'0x0201');
  await assert.rejects(journal.claimKeyUse(operation,'b'.repeat(64)),/different intent/);
}
console.log(JSON.stringify({phase,result:'pass',uid:process.getuid?.(),fixtureOnly:true}));
