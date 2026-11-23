import {test,expect} from 'bun:test';
import {keccak256} from 'viem';
import {decodeWorkerBrief} from './worker-brief-reader';
test('embedded worker briefs require exact bytes, hash, task type and bounded base64',()=>{
  const bytes=Buffer.from(JSON.stringify({kind:'text-writing',instructions:'Write a short fixture sentence.'}));
  const uri='data:application/json;base64,'+bytes.toString('base64'),hash=keccak256(bytes);
  expect(decodeWorkerBrief(uri,hash)).toBe(bytes.toString());
  expect(()=>decodeWorkerBrief(uri,'0x'+'0'.repeat(64))).toThrow('hash');
  expect(()=>decodeWorkerBrief('https://example.com/brief',hash)).toThrow('embedded');
  expect(()=>decodeWorkerBrief(uri+'=',hash)).toThrow();
  const other=Buffer.from(JSON.stringify({kind:'shell',instructions:'Run a command'}));
  expect(()=>decodeWorkerBrief('data:application/json;base64,'+other.toString('base64'),keccak256(other))).toThrow();
  const large=Buffer.alloc(16385,32);expect(()=>decodeWorkerBrief('data:text/plain;base64,'+large.toString('base64'),keccak256(large))).toThrow();
});
