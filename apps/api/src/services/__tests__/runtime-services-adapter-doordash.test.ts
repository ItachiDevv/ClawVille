import { describe, expect, test } from 'bun:test';
import type { DoordashReadOnlyBridge } from '../../../../../packages/agent-runtime/dist/actions/doordash.js';
import type { DoordashBridge } from '../doordash-operator';
import { buildRuntimeServices } from '../runtime-services-adapter';

// API tsc includes this test. A chunk 1 bridge change must satisfy the runtime
// contract without importing any API module into packages/agent-runtime.
const bridgeContractMatches: DoordashBridge extends DoordashReadOnlyBridge ? true : false = true;

describe('runtime service DoorDash capability injection', () => {
  test('chunk 1 bridge satisfies the runtime read-only contract', () => {
    expect(bridgeContractMatches).toBe(true);
  });

  test('db-only and existing actor-kind options remain compatible without a capability', () => {
    const db = Object.freeze({ test: 'No database calls' });
    for (const services of [
      buildRuntimeServices(db),
      buildRuntimeServices(db, { actorKind: 'human' }),
      buildRuntimeServices(db, { actorKind: 'agent' }),
      buildRuntimeServices(db, { actorKind: null }),
    ]) {
      expect(services.db).toBe(db);
      expect(services.doordash).toBeUndefined();
      expect(typeof services.creditClawTokens).toBe('function');
      expect(typeof services.debitClawTokens).toBe('function');
      expect(typeof services.recordCovenantAction).toBe('function');
    }
  });

  test('passes the exact optional capability through without invoking it', () => {
    const db = Object.freeze({ test: 'No database calls' });
    const bridge = new Proxy({}, { get() { throw new Error('Capability must not execute in the adapter'); } });
    expect(buildRuntimeServices(db, { actorKind: 'human', doordash: bridge }).doordash).toBe(bridge);
    expect(buildRuntimeServices(db, { actorKind: 'agent', doordash: bridge }).doordash).toBe(bridge);
    expect(buildRuntimeServices(db, { doordash: bridge }).doordash).toBe(bridge);
  });
});
