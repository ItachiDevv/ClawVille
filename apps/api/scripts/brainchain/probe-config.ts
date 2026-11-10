/**
 * Staging-only: build the protected probe bootstrap config from the prepared fixture artifact.
 * Runs inside the API container (same SOURCE_COMMIT and source builders as boot). Writes the config
 * 0600 with an exclusive create; prints ids and hashes only. Reads no credential.
 *
 *   bun apps/api/scripts/brainchain/probe-config.ts <prepared.json> <config.json>
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readRootTrialRecord, writeRootTrialRecord } from '../../src/services/brainchain/root-compute-store';
import { getProbeSourceEvidence, probeBootstrapConfigSchema } from '../../src/services/brainchain/probe-bootstrap';
import { probeManifestHash, probeManifestSchema } from '../../src/services/brainchain/probe-embedding-budget';

const JOB_ID = '2482562a-c3fd-4684-b3a8-963224c4f479';
const ROOT = '/var/lib/brainchain-probe';
const [preparedPath, configPath] = process.argv.slice(2);
try {
  if (process.env.CLAWVILLE_ENV !== 'staging' || process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('staging linux root only');
  if (!preparedPath || !configPath) throw new Error('usage: <prepared.json> <config.json>');
  const sourceCommit = process.env.SOURCE_COMMIT; if (!sourceCommit) throw new Error('SOURCE_COMMIT missing');
  const prepared = z.object({ runId: z.string().uuid(), fixture: z.object({ userId: z.string().uuid(), avatarId: z.string().uuid(), platformAgentId: z.string().uuid() }).passthrough() }).passthrough()
    .parse(JSON.parse(await readRootTrialRecord(preparedPath, 0)));
  const evidence = await getProbeSourceEvidence();
  const now = Date.now();
  const manifest = probeManifestSchema.parse({ version: 1, runId: prepared.runId, envelopeId: randomUUID(), jobId: JOB_ID,
    userId: prepared.fixture.userId, avatarId: prepared.fixture.avatarId, platformAgentId: prepared.fixture.platformAgentId, runtimeAgentId: prepared.fixture.platformAgentId,
    sourceCommit, apiOrigin: 'https://api-staging.clawville.world', protocolHash: evidence.protocolHash, curriculumHash: evidence.curriculumHash,
    protocolInputs: evidence.protocolInputs, brainchainInputs: evidence.brainchainInputs,
    maxCalls: 2 * evidence.protocolInputs.length + evidence.brainchainInputs.length + 32, maxStarts: 2,
    startedAtMs: now, expiresAtMs: now + 480_000, model: 'text-embedding-3-small', dimensions: 1536, pricingVersion: 'openai-embedding-20261109-v1', maximumMicros: '200' });
  const config = probeBootstrapConfigSchema.parse({ version: 1, manifest, manifestHash: probeManifestHash(manifest),
    pinPath: `${ROOT}/root/pin.json`, headPath: `${ROOT}/root/head.json`, historyDirectory: `${ROOT}/history`, credentialPath: `${ROOT}/root/openai-key`,
    gatewayUrl: 'http://127.0.0.1:18745', rootReservationId: randomUUID() });
  await writeRootTrialRecord(configPath, 0, config);
  console.log(JSON.stringify({ ok: true, runId: manifest.runId, envelopeId: manifest.envelopeId, rootReservationId: config.rootReservationId, manifestHash: config.manifestHash,
    maxCalls: manifest.maxCalls, limitMicros: manifest.maxCalls * 200, startedAtMs: manifest.startedAtMs, expiresAtMs: manifest.expiresAtMs, sourceCommit }));
} catch (error) {
  console.error(`probe-config refused: ${error instanceof Error ? error.message.slice(0, 300) : 'error'}`);
  process.exitCode = 1;
}
