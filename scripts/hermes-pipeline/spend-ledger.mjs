// spend-ledger.mjs — persistent RESERVATION ledger for paid generation calls
// (owner rule 2026-10-04: every paid tool enforces the owner's cap in code).
//
// Pattern for every paid request:
//   1. reserveSpend(): take an exclusive lock file, RELOAD the ledger from disk,
//      refuse when booked + estimate > cap, persist the reservation atomically
//      (temp file + rename), release the lock.
//   2. Only then send the paid request.
//   3. updateSpendEntry(): record the result (task id, usage, ok) under the lock.
//
// The booked total only grows. A reservation is never released when a call
// fails (a failed request may still be billed), so the cap stays an upper bound.
// The total is independent of any provider account balance, so top-ups and
// concurrent runs cannot raise the headroom.
//
// Ledger file: { [totalKey]: number, calls: [{ id, at, label, ...entry }] }.
// totalKey defaults to 'bookedUsd' (the hydra-turnaround spend.json format).

import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const LOCK_TIMEOUT_MS = 10_000;
export const STALE_LOCK_MS = 120_000;
const LOCK_RETRY_MS = 25;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export class SpendRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpendRefusedError';
  }
}

/** Write JSON to `path` atomically: a unique temp file in the same directory, then rename over the target. */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  // Windows can briefly refuse a rename over a file another process is reading (EPERM / EBUSY).
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (attempt >= 20 || (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES')) {
        try { unlinkSync(tmp); } catch {}
        throw err;
      }
      Atomics.wait(SLEEP_CELL, 0, 0, 10); // short synchronous back-off
    }
  }
}

/**
 * Break a lock older than staleMs. Rename it to a unique name first (only one breaker can win the
 * rename); if the renamed file turns out to be fresh, a live holder created it between our stat and
 * our rename, so put it back.
 */
function breakStaleLock(lockPath, staleMs) {
  const tomb = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, tomb);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  let ageMs = Infinity;
  try { ageMs = Date.now() - statSync(tomb).mtimeMs; } catch {}
  if (ageMs < staleMs) {
    try { linkSync(tomb, lockPath); } catch {}
  } else {
    let holder = '';
    try { holder = readFileSync(tomb, 'utf8').trim(); } catch {}
    console.warn(`[spend-ledger] broke a stale lock ${lockPath} (age ${Math.round(ageMs / 1000)} s, holder ${holder || 'unknown'})`);
  }
  try { unlinkSync(tomb); } catch {}
}

/** Run fn while holding an exclusive lock file (created with flag 'wx'). Waits at most timeoutMs. */
export async function withFileLock(lockPath, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = STALE_LOCK_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // released between open and stat
        throw statErr;
      }
      if (ageMs > staleMs) {
        breakStaleLock(lockPath, staleMs);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SpendRefusedError(
          `refusing: ledger lock ${lockPath} is held by another process (waited ${timeoutMs} ms). ` +
            `If no paid run is active, delete the lock file.`,
        );
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    try {
      return await fn();
    } finally {
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

function loadLedger(ledgerPath, totalKey, init) {
  const ledger = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
    : ((init ? init() : null) ?? { [totalKey]: 0, calls: [] });
  if (!ledger || typeof ledger !== 'object' || !Number.isFinite(ledger[totalKey]) || !Array.isArray(ledger.calls)) {
    throw new SpendRefusedError(`refusing: ledger ${ledgerPath} is not a valid { ${totalKey}, calls[] } file`);
  }
  return ledger;
}

/**
 * Reserve `amount` against `cap` in the ledger at ledgerPath BEFORE a paid call.
 * Returns { total, id }: the new booked total and the reservation id (for updateSpendEntry).
 * Throws SpendRefusedError when the cap is missing or invalid, or when booked + amount > cap.
 * `init` (optional) returns the starting ledger when the file does not exist yet (migration seed).
 */
export async function reserveSpend({
  ledgerPath,
  amount,
  cap,
  label,
  totalKey = 'bookedUsd',
  entry = {},
  init,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  staleLockMs = STALE_LOCK_MS,
}) {
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    throw new SpendRefusedError(`refusing paid '${label}': no owner-approved spend cap (got ${String(cap)})`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new SpendRefusedError(`refusing paid '${label}': invalid cost estimate ${String(amount)}`);
  }
  return withFileLock(
    `${ledgerPath}.lock`,
    () => {
      const ledger = loadLedger(ledgerPath, totalKey, init);
      const booked = ledger[totalKey];
      if (booked + amount > cap) {
        throw new SpendRefusedError(
          `refusing paid '${label}': booked ${booked} + estimate ${amount} > cap ${cap} (ledger ${ledgerPath})`,
        );
      }
      const id = randomUUID();
      const total = Number((booked + amount).toFixed(6));
      ledger[totalKey] = total;
      ledger.calls.push({ at: new Date().toISOString(), label, ...entry, id });
      writeJsonAtomic(ledgerPath, ledger);
      return { total, id };
    },
    { timeoutMs: lockTimeoutMs, staleMs: staleLockMs },
  );
}

/** Merge `patch` into the reservation `id` (task id, usage, ok) under the same lock. The total never changes. */
export async function updateSpendEntry({
  ledgerPath,
  id,
  patch,
  totalKey = 'bookedUsd',
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  staleLockMs = STALE_LOCK_MS,
}) {
  return withFileLock(
    `${ledgerPath}.lock`,
    () => {
      const ledger = loadLedger(ledgerPath, totalKey);
      const call = ledger.calls.find((c) => c && c.id === id);
      if (!call) throw new Error(`spend-ledger: reservation ${id} not found in ${ledgerPath}`);
      Object.assign(call, patch, { id });
      writeJsonAtomic(ledgerPath, ledger);
    },
    { timeoutMs: lockTimeoutMs, staleMs: staleLockMs },
  );
}
