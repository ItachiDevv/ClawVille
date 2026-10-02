/**
 * Security H4 (2026-09-30) — the x402 MOCK facilitator rubber-stamps settlement
 * and would mint free vCLAW. The module-load guard in x402-config.ts used to
 * refuse only when CLAWVILLE_ENV === 'production', so a box with CLAWVILLE_ENV
 * unset booted with the mock. It now refuses unless CLAWVILLE_ENV === 'staging',
 * matching the index.ts mount guard. Each case imports the module in a fresh Bun
 * process (the guard runs once at load).
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'path';

const cwd = join(import.meta.dir, '..', '..', '..');
const importStatement = "await import('./src/services/x402-config.ts')";

function load(env: Record<string, string | undefined>) {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('X402_') && key !== 'CLAWVILLE_ENV') base[key] = value;
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) base[key] = value;
  return Bun.spawnSync([process.execPath, '-e', importStatement], {
    cwd,
    env: base,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('x402 mock facilitator boot guard (security H4)', () => {
  it('refuses the mock preset when CLAWVILLE_ENV is unset', () => {
    const result = load({ X402_FACILITATOR_PRESET: 'mock' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not 'staging'");
  });

  it('refuses X402_MOCK_FACILITATOR=true when CLAWVILLE_ENV is unset or production', () => {
    expect(load({ X402_MOCK_FACILITATOR: 'true' }).exitCode).not.toBe(0);
    expect(load({ X402_MOCK_FACILITATOR: 'true', CLAWVILLE_ENV: 'production' }).exitCode).not.toBe(0);
  });

  it('allows the mock only on staging', () => {
    expect(load({ X402_FACILITATOR_PRESET: 'mock', CLAWVILLE_ENV: 'staging' }).exitCode).toBe(0);
  });

  it('boots without the mock whatever CLAWVILLE_ENV is', () => {
    expect(load({}).exitCode).toBe(0);
    expect(load({ X402_FACILITATOR_PRESET: 'payai', CLAWVILLE_ENV: 'production' }).exitCode).toBe(0);
  });
});
