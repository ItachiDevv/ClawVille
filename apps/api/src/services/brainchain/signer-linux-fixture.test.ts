/** Isolated Linux fixture only. Known synthetic key, no network, no keyring, no production gate change. Run alone. */
import {describe,test,expect,mock} from 'bun:test';
import {mkdtemp,mkdir,writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {recoverTransactionAddress,encodeFunctionData,parseTransaction} from 'viem';
import {createProtectedSignerJournal,createProtectedResultSignatureJournal} from './signer-payload-store';
import {freezeResultSignatureIntent,resultSignatureClaimHash,verifyResultSignature} from './result-signing-policy';
import type {FrozenSignerTransaction} from './signer-service';
import {BRAINCHAIN_CONTRACTS} from './contracts';

const enabled=process.platform==='linux'&&process.getuid?.()===10001&&Boolean(process.env.BRAINCHAIN_SIGNER_STORE_TEST_ROOT);
describe.skipIf(!enabled)('BrainChain isolated Linux synthetic key fixture',()=>{
  test('closed gate precedes key access; reviewed test override proves capture and single-use recovery',async()=>{
    const root=await mkdtemp(join(process.env.BRAINCHAIN_SIGNER_STORE_TEST_ROOT!,'driver-'));await chmod(root,0o700);
    const keyDirectory=join(root,'keys'),journalDirectory=join(root,'journal');
    await mkdir(keyDirectory,{mode:0o700});await mkdir(journalDirectory,{mode:0o700});
    const synthetic=`0x${'1'.padStart(64,'0')}` as const;
    const address=privateKeyToAccount(synthetic).address.toLowerCase();
    const key={reference:'brainchain-testnet:synthetic-fixture',filename:'synthetic.key',address};
    const journal=await createProtectedSignerJournal(journalDirectory,10001);
    const policy=await import('./signer-policy');
    const {createLinuxSignerDriver}=await import('./signer-linux-driver');
    const driver=await createLinuxSignerDriver(keyDirectory,10001,[key],journal);
    const resultJournal=await createProtectedResultSignatureJournal(journalDirectory,10001);
    const resultDriver=await createLinuxSignerDriver(keyDirectory,10001,[key],journal,resultJournal);
    const resultIntent=freezeResultSignatureIntent({domain:'brainchain-result-v2',chainId:274630,resultId:randomUUID(),board:BRAINCHAIN_CONTRACTS.testnet.contracts.board,task:'7',hash:`0x${'a'.repeat(64)}`,worker:address});
    await expect(resultDriver.signResult(randomUUID(),key.reference,resultIntent,async()=>{})).rejects.toThrow('artifact equivalence');
    const transaction:FrozenSignerTransaction={chainId:274630,type:'eip1559',to:BRAINCHAIN_CONTRACTS.testnet.contracts.brain,
      data:encodeFunctionData({abi:policy.signerAbi,functionName:'faucet'}),value:0n,nonce:0,gas:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n};
    const operation=randomUUID();
    await expect(driver.signTransaction(operation,key.reference,transaction)).rejects.toThrow('artifact equivalence');
    expect(await journal.findByOperation(operation)).toBeNull();
    await writeFile(join(keyDirectory,key.filename),synthetic.slice(2),{mode:0o600,flag:'wx'});
    const intentHash=createHash('sha256').update(JSON.stringify({reference:key.reference,transaction},(_name,value)=>typeof value==='bigint'?value.toString():value)).digest('hex');
    await journal.claimKeyUse(operation,intentHash);
    mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{}}));
    const current={assertCurrent:async()=>{}};
    try{
      const signed=await driver.signTransaction(operation,key.reference,transaction,current);
      expect((await recoverTransactionAddress({serializedTransaction:signed as `0x02${string}`})).toLowerCase()).toBe(address);
      expect((await journal.findByOperation(operation))?.bytes).toBe(signed);
      // A corrupt key file proves replay uses captured bytes, never another key read.
      await writeFile(join(keyDirectory,key.filename),'x'.repeat(64));
      expect(await driver.signTransaction(operation,key.reference,transaction,current)).toBe(signed);
      await expect(driver.signTransaction(operation,key.reference,{...transaction,nonce:1},current)).rejects.toThrow('coordinator claim');
      await chmod(join(keyDirectory,key.filename),0o644);
      const badPermissions=randomUUID();await journal.claimKeyUse(badPermissions,intentHash);
      await expect(driver.signTransaction(badPermissions,key.reference,transaction,current)).rejects.toThrow('Private signer key');
      await chmod(join(keyDirectory,key.filename),0o600);
      // ASCII decoding would alias these high-bit bytes to the valid synthetic key.
      await writeFile(join(keyDirectory,key.filename),Buffer.from([...synthetic.slice(2)].map(character=>character.charCodeAt(0)|0x80)));
      const badEncoding=randomUUID();await journal.claimKeyUse(badEncoding,intentHash);
      await expect(driver.signTransaction(badEncoding,key.reference,transaction,current)).rejects.toThrow('private key encoding');
      await writeFile(join(keyDirectory,key.filename),synthetic.slice(2));
      for(const boundary of [1,2]){
        const stale=randomUUID();await journal.claimKeyUse(stale,intentHash);let checks=0;
        await expect(driver.signTransaction(stale,key.reference,transaction,{assertCurrent:async()=>{if(++checks===boundary)throw Error('job lease expired or policy revoked');}})).rejects.toThrow('job lease');
        expect(checks).toBe(boundary);expect(await journal.findByOperation(stale)).toBeNull();
        await expect(driver.signTransaction(stale,key.reference,transaction,current)).rejects.toThrow('Ambiguous key use');
      }
      let entered!:()=>void,release!:()=>void;
      const waiting=new Promise<void>(done=>{entered=done;}),resume=new Promise<void>(done=>{release=done;});
      const deferred=await createLinuxSignerDriver(keyDirectory,10001,[key],{...journal,async claimDriverUse(id,hash){entered();await resume;return journal.claimDriverUse(id,hash);}});
      const mutable={...transaction},mutationOperation=randomUUID();await journal.claimKeyUse(mutationOperation,intentHash);
      const pending=deferred.signTransaction(mutationOperation,key.reference,mutable,current);
      await waiting;
      mutable.to=`0x${'2'.repeat(40)}`;mutable.data='0x';mutable.gas=999999n;mutable.maxFeePerGas=999999n;mutable.nonce=99;
      release();
      const captured=await pending,decoded=parseTransaction(captured);
      expect(decoded.to?.toLowerCase()).toBe(transaction.to);expect(decoded.data).toBe(transaction.data);
      expect(decoded.gas).toBe(transaction.gas);expect(decoded.maxFeePerGas).toBe(transaction.maxFeePerGas);expect(decoded.nonce).toBe(transaction.nonce);
      expect((await journal.findByOperation(mutationOperation))?.bytes).toBe(captured);
      const resultOperation=randomUUID();await resultJournal.claimKeyUse(resultOperation,resultSignatureClaimHash(key.reference,resultIntent));
      let checks=0;
      const signature=await resultDriver.signResult(resultOperation,key.reference,resultIntent,async()=>{checks++;});
      await verifyResultSignature(signature,resultIntent);expect(checks).toBe(2);
      expect((await resultJournal.findByOperation(resultOperation))?.bytes).toBe(signature);
      expect(await journal.findByOperation(resultOperation)).toBeNull();
      await expect(journal.putIfAbsent(randomUUID(),signature)).rejects.toThrow('Invalid protected payload');
      await expect(resultJournal.putIfAbsent(randomUUID(),signed)).rejects.toThrow('Invalid protected payload');
      const reopened=await createProtectedResultSignatureJournal(journalDirectory,10001);
      const recoveredDriver=await createLinuxSignerDriver(keyDirectory,10001,[key],journal,reopened);
      await writeFile(join(keyDirectory,key.filename),'x'.repeat(64));
      expect(await recoveredDriver.signResult(resultOperation,key.reference,resultIntent,async()=>{throw Error('expired authority');})).toBe(signature);
      await writeFile(join(keyDirectory,key.filename),synthetic.slice(2));
      const revokedOperation=randomUUID();await resultJournal.claimKeyUse(revokedOperation,resultSignatureClaimHash(key.reference,resultIntent));
      let revocationChecks=0;
      await expect(resultDriver.signResult(revokedOperation,key.reference,resultIntent,async()=>{if(++revocationChecks===2)throw Error('revoked after file reads');})).rejects.toThrow('revoked after file reads');
      expect(await resultJournal.findByOperation(revokedOperation)).toBeNull();
      await expect(resultDriver.signResult(revokedOperation,key.reference,resultIntent,async()=>{})).rejects.toThrow('Ambiguous result key use');
      const submit={kind:'submit' as const,resultId:resultIntent.resultId,task:resultIntent.task,hash:resultIntent.hash,uri:`https://brain.testnet.usebrainchain.com/records/${resultIntent.hash}.txt`};
      const submitTransaction:FrozenSignerTransaction={...transaction,to:BRAINCHAIN_CONTRACTS.testnet.contracts.board,data:encodeFunctionData({abi:policy.signerAbi,functionName:'submit',args:[7n,resultIntent.hash as `0x${string}`,submit.uri]}),nonce:1};
      const submitOperation=randomUUID(),submitHash=createHash('sha256').update(JSON.stringify({reference:key.reference,transaction:submitTransaction},(_name,value)=>typeof value==='bigint'?value.toString():value)).digest('hex');
      await journal.claimKeyUse(submitOperation,submitHash);
      await expect(driver.signTransaction(submitOperation,key.reference,submitTransaction)).rejects.toThrow('Typed submit authority');
      const submitBytes=await driver.signTransaction(submitOperation,key.reference,submitTransaction,{result:submit,assertCurrent:async()=>{}});
      expect(parseTransaction(submitBytes).data).toBe(submitTransaction.data);
      expect(await driver.signTransaction(submitOperation,key.reference,submitTransaction,{result:submit,assertCurrent:async()=>{throw Error('expired');}})).toBe(submitBytes);
    }finally{mock.restore();}
  });
});
