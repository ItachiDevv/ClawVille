/**
 * Verification script for FIX B — agent.connected rapid-reconnect coalescing
 * (event-logger.ts shouldEmitAgentConnected), the emission-side defense-in-depth
 * backstop to the session farm.
 *
 * Drives the pure-ish gate directly with an injected clock (nowMs) — no DB, no
 * network, no insert. Asserts:
 *   1. First call for a key  => true  (EMIT).
 *   2. Same key at now+1000ms => false (SKIP — inside the 60s coalescing window).
 *   3. Same key at now+61000ms => true (EMIT — window elapsed).
 *   4. A DIFFERENT key always  => true (independent subjects never coalesce).
 *
 * Run:  bun run scripts/leaderboard/verify-coalesce.ts   (from apps/api)
 * Exit: 0 on all-pass, 1 on any FAIL.
 */

// event-logger.ts imports `db` from @clawville/database (module-load), which
// only throws on first USE (lazy Proxy), not on import — but the DB package's
// dotenv autoload reads .env.local. No DB connection is opened by importing the
// pure gate, so this test never touches Postgres.
import { shouldEmitAgentConnected } from '../../src/services/event-logger';

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}
const results: Assertion[] = [];
function assert(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}

function main() {
  console.log('=== Fix B coalescing gate verification (shouldEmitAgentConnected) ===');
  console.log('');

  // Use a unique base key so we never collide with any other test state in the
  // same module instance, and a fixed synthetic clock origin.
  const KEY = `subjA:fp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const OTHER = `subjB:fp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const t0 = 1_000_000_000_000; // arbitrary fixed origin

  const first = shouldEmitAgentConnected(KEY, t0);
  assert('1. first call for a key => true (EMIT)', first === true, `got ${first}`);

  const within = shouldEmitAgentConnected(KEY, t0 + 1000);
  assert(
    '2. same key at +1000ms => false (SKIP, inside 60s window)',
    within === false,
    `got ${within}`,
  );

  const after = shouldEmitAgentConnected(KEY, t0 + 61_000);
  assert(
    '3. same key at +61000ms => true (EMIT, window elapsed)',
    after === true,
    `got ${after}`,
  );

  // Different key — first sight, always emits regardless of the other key's
  // recent activity. Tested at the same t0 to prove independence, not timing.
  const other = shouldEmitAgentConnected(OTHER, t0 + 1000);
  assert(
    '4. a different key => true (independent subject never coalesces)',
    other === true,
    `got ${other}`,
  );

  // Bonus: the just-emitted KEY at +61000ms recorded a NEW last-emit, so an
  // immediate follow-up should coalesce again (proves recording on EMIT).
  const followUp = shouldEmitAgentConnected(KEY, t0 + 61_500);
  assert(
    '5. follow-up 500ms after the +61000ms emit => false (last-emit was re-recorded)',
    followUp === false,
    `got ${followUp}`,
  );

  // SUMMARY
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log('');
  console.log('========================================================');
  console.log(`SUMMARY: ${passed} PASS / ${failed} FAIL  (total ${results.length})`);
  console.log('========================================================');

  process.exit(failed > 0 ? 1 : 0);
}

main();
