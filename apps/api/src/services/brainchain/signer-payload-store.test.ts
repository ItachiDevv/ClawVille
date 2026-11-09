/** Run under the dedicated Linux fixture UID with a private writable test-root mount. No key or signature is created. */
import {beforeAll,describe,expect,test} from 'bun:test';
import {chmod,mkdtemp,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProtectedSignerJournal} from './signer-payload-store';

const enabled=process.platform==='linux'&&Boolean(process.getuid?.())&&Boolean(process.env.BRAINCHAIN_SIGNER_STORE_TEST_ROOT);
describe.skipIf(!enabled)('BrainChain real Linux protected signer journal',()=>{
  let directory:string;
  const uid=process.getuid?.()??-1;
  beforeAll(async()=>{directory=await mkdtemp(join(process.env.BRAINCHAIN_SIGNER_STORE_TEST_ROOT!,'journal-'));await chmod(directory,0o700);});
  test('operation claim is single-use and survives reopening without another key use',async()=>{
    const store=await createProtectedSignerJournal(directory,uid),operation=randomUUID(),hash='a'.repeat(64);
    await expect(store.claimDriverUse(operation,hash)).rejects.toThrow('coordinator claim');
    expect(await store.claimKeyUse(operation,hash)).toBe(true);
    expect(await store.claimDriverUse(operation,hash)).toBe(true);
    const reopened=await createProtectedSignerJournal(directory,uid);
    expect(await reopened.claimKeyUse(operation,hash)).toBe(false);
    expect(await reopened.claimDriverUse(operation,hash)).toBe(false);
    expect(await reopened.findByOperation(operation)).toBeNull();
    await expect(reopened.claimKeyUse(operation,'b'.repeat(64))).rejects.toThrow('different intent');
  });
  test('captured bytes survive reopening and cannot be replaced for an operation',async()=>{
    const store=await createProtectedSignerJournal(directory,uid),operation=randomUUID();
    const reference=await store.putIfAbsent(operation,'0x0201');
    const reopened=await createProtectedSignerJournal(directory,uid);
    expect(await reopened.findByOperation(operation)).toEqual({reference,bytes:'0x0201'});
    expect(await reopened.putIfAbsent(operation,'0x0201')).toBe(reference);
    await expect(reopened.putIfAbsent(operation,'0x0202')).rejects.toThrow('different bytes');
    expect(await reopened.get(reference)).toBe('0x0201');
  });
  test('world-readable payloads, symlink directories, and path references fail closed',async()=>{
    const store=await createProtectedSignerJournal(directory,uid),reference=await store.putIfAbsent(randomUUID(),'0x0203');
    await chmod(join(directory,`${reference}.payload`),0o644);
    await expect(store.get(reference)).rejects.toThrow('permissions');
    await chmod(join(directory,`${reference}.payload`),0o600);
    await expect(store.get('../key')).rejects.toThrow('reference');
    const alias=directory+'-link';await symlink(directory,alias);
    await expect(createProtectedSignerJournal(alias,uid)).rejects.toThrow('directory');
  });
});
test.skipIf(process.platform==='linux')('Windows does not substitute mode bits for an ACL custody proof',async()=>{
  await expect(createProtectedSignerJournal('unused',10001)).rejects.toThrow('Dedicated Linux');
});
