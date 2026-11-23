import {test,expect} from 'bun:test';
import {parsePolicyAmount,formatPolicyAmount} from './worker-policy-amounts';
test('owner amount conversion is exact and refuses excess precision',()=>{
  expect(parsePolicyAmount('0.000001',6)).toBe('1');
  expect(parsePolicyAmount('500',18)).toBe('500000000000000000000');
  expect(formatPolicyAmount('1000001',6)).toBe('1.000001');
  expect(formatPolicyAmount('0',18)).toBe('0');
  expect(()=>parsePolicyAmount('0.0000001',6)).toThrow('at most');
  expect(()=>parsePolicyAmount('1e3',6)).toThrow('decimal');
  expect(()=>parsePolicyAmount('-1',6)).toThrow('decimal');
  expect(formatPolicyAmount('untrusted',6)).toBe('Invalid amount');
});
