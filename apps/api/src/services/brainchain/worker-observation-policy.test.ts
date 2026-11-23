import {test,expect} from 'bun:test';
import {WORKER_PROVISIONAL_POLICY,workerObservationFresh} from './worker-observation-policy';
test('only explicit worker provisional evidence accepts an idle historical block within acquisition TTL',()=>{
  const now=new Date('2026-11-09T18:00:00Z'),observedAt=new Date(now.getTime()-29000),blockTimestamp=BigInt(now.getTime()/1000)-10000n;
  expect(workerObservationFresh({observedAt,blockTimestamp},now)).toBe(false);
  expect(workerObservationFresh({observedAt,blockTimestamp,observationPolicy:WORKER_PROVISIONAL_POLICY},now)).toBe(true);
  expect(workerObservationFresh({observedAt:new Date(now.getTime()-30001),blockTimestamp,observationPolicy:WORKER_PROVISIONAL_POLICY},now)).toBe(false);
  expect(workerObservationFresh({observedAt:new Date(now.getTime()+1),blockTimestamp,observationPolicy:WORKER_PROVISIONAL_POLICY},now)).toBe(false);
  expect(workerObservationFresh({observedAt,blockTimestamp:BigInt(now.getTime()/1000)+1n,observationPolicy:WORKER_PROVISIONAL_POLICY},now)).toBe(false);
});
