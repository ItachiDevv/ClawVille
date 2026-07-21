/**
 * SAP config — mainnet-enablement invariants (2026-07-10).
 *
 * Pins the money-load-bearing cluster constants: the USDC mint mapping (a wrong
 * mainnet mint would send REAL USDC to the wrong token), the FULL mainnet genesis
 * hash the live-send guard compares against (a truncated value silently fails the
 * guard OPEN), and the two-lock mainnet gate in its now-enabled state. Compares
 * against canonical EXTERNAL values (not sourced from our own code) so a drift in
 * either direction fails.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import {
  loadSapConfig,
  SAP_ALLOW_MAINNET,
  SOLANA_MAINNET_GENESIS_HASH,
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
} from '../sap-config';

// Canonical public constants — the ground truth these must equal.
const CANONICAL_USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CANONICAL_USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const CANONICAL_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
// The CAIP-2 reference (x402-payai) is exactly the first 32 chars of the genesis hash.
const MAINNET_CAIP2_REFERENCE = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

describe('SAP config — mainnet money constants', () => {
  it('pins the mainnet USDC mint (Circle USDC) — a wrong mint would move REAL USDC to the wrong token', () => {
    expect(USDC_MINT_MAINNET).toBe(CANONICAL_USDC_MINT_MAINNET);
  });

  it('pins the devnet USDC mint', () => {
    expect(USDC_MINT_DEVNET).toBe(CANONICAL_USDC_MINT_DEVNET);
  });

  it('pins the FULL 44-char mainnet genesis hash (the live-send guard compares getGenesisHash() against it)', () => {
    // Regression guard for the 2026-07-10 fix: the constant previously held the
    // 32-char CAIP-2 truncation, which never matched getGenesisHash()'s 44-char
    // return and SILENTLY DEFEATED the mainnet-broadcast refusal (fail-open).
    expect(SOLANA_MAINNET_GENESIS_HASH).toBe(CANONICAL_MAINNET_GENESIS_HASH);
    expect(SOLANA_MAINNET_GENESIS_HASH.length).toBe(44);
    expect(SOLANA_MAINNET_GENESIS_HASH.slice(0, 32)).toBe(MAINNET_CAIP2_REFERENCE);
  });
});

describe('SAP config — two-lock mainnet gate', () => {
  const saved = { cluster: process.env.SAP_CLUSTER, rpc: process.env.SAP_RPC_URL };
  afterEach(() => {
    if (saved.cluster === undefined) delete process.env.SAP_CLUSTER;
    else process.env.SAP_CLUSTER = saved.cluster;
    if (saved.rpc === undefined) delete process.env.SAP_RPC_URL;
    else process.env.SAP_RPC_URL = saved.rpc;
  });

  it('LOCK 1 — the code constant is TRUE (the reviewed mainnet flip happened)', () => {
    expect(SAP_ALLOW_MAINNET).toBe(true);
  });

  it('LOCK 2 — SAP_CLUSTER=mainnet no longer throws with the constant true, and resolves the mainnet mint', () => {
    process.env.SAP_CLUSTER = 'mainnet';
    delete process.env.SAP_RPC_URL; // mainnet public default (mainnet gate on ⇒ no RPC-guard throw)
    const cfg = loadSapConfig();
    expect(cfg.cluster).toBe('mainnet');
    expect(cfg.usdcMint.toBase58()).toBe(CANONICAL_USDC_MINT_MAINNET);
  });

  it('LOCK 2 — a box WITHOUT SAP_CLUSTER=mainnet stays fully devnet (flipping LOCK 1 alone moves no cluster)', () => {
    delete process.env.SAP_CLUSTER; // default
    delete process.env.SAP_RPC_URL;
    const cfg = loadSapConfig();
    expect(cfg.cluster).toBe('devnet');
    expect(cfg.usdcMint.toBase58()).toBe(CANONICAL_USDC_MINT_DEVNET);
  });
});

describe('SAP config - automatic identity rollback lever', () => {
  const saved = process.env.SAP_IDENTITY_AUTOREG_ENABLED;

  afterEach(() => {
    if (saved === undefined) delete process.env.SAP_IDENTITY_AUTOREG_ENABLED;
    else process.env.SAP_IDENTITY_AUTOREG_ENABLED = saved;
  });

  it('defaults automatic registration ON when the rollback lever is omitted', () => {
    delete process.env.SAP_IDENTITY_AUTOREG_ENABLED;
    expect(loadSapConfig().identityAutoregEnabled).toBe(true);
  });

  it('turns automatic registration off only when explicitly set to false', () => {
    process.env.SAP_IDENTITY_AUTOREG_ENABLED = 'false';
    expect(loadSapConfig().identityAutoregEnabled).toBe(false);
  });
});
