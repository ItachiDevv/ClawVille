import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
// @ts-ignore -- the CLI is an intentionally plain Node module.
import { buildOfficePayload, createOfficeMeshyDriver, validateAssetUrl, validTaskId } from './meshy-office.mjs';

const TASK = '018a210d-8ba4-705c-b111-1f1776f7f578';
const OTHER = '018a210d-8ba4-705c-b111-1f1776f7f579';
const testRoot = resolve(import.meta.dir, '../../.brainchain-work/meshy-tests');
let workspace = '';

function png() {
  const image = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  image.writeUInt32BE(512, 16); image.writeUInt32BE(512, 20);
  return image;
}
beforeEach(() => {
  mkdirSync(testRoot, { recursive: true });
  workspace = mkdtempSync(join(testRoot, 'case-'));
  const refs = join(workspace, 'docs/research/brainchain-2026-11-09/3d/refs');
  mkdirSync(refs, { recursive: true });
  for (const name of ['front.png', 'back.png', '3q.png']) writeFileSync(join(refs, name), png());
});
afterEach(() => {
  if (!resolve(workspace).startsWith(`${testRoot}${sep}`)) throw new Error('Test cleanup escaped its own directory.');
  rmSync(workspace, { recursive: true, force: true });
});
const stored = () => JSON.parse(readFileSync(join(workspace, '.brainchain-work/meshy/office-v1/task.json'), 'utf8'));

test('payload uses the supported standard N1 recipe and no legacy texture options', () => {
  const payload = buildOfficePayload([png(), png(), png()]);
  expect(payload).toMatchObject({ ai_model: 'meshy-7.1', geometry_resolution: 'standard', texture_model: 'meshy-n1', texture_resolution: '2k', topology: 'triangle', target_polycount: 12000, enable_pbr: false });
  expect(payload.remove_lighting).toBeUndefined();
  expect(payload.symmetry_mode).toBeUndefined();
  expect(payload.image_urls).toHaveLength(3);
  expect(() => buildOfficePayload([png()])).toThrow();
});

test('dry-run reads no credentials, reserves no budget, and makes no network request', () => {
  const driver = createOfficeMeshyDriver({ workspace, keyLoader: () => { throw new Error('No credential read allowed'); }, fetchFn: () => { throw new Error('No network allowed'); } });
  expect(driver.dryRun()).toMatchObject({ credits: 30, views: ['front.png', 'back.png', '3q.png'] });
  expect(existsSync(join(workspace, '.brainchain-work/meshy/credit-ledger.json'))).toBe(false);
});

test('submit reserves before POST, persists the task ID, and refuses a second POST', async () => {
  let calls = 0;
  const driver = createOfficeMeshyDriver({ workspace, keyLoader: () => 'test-only-key', fetchFn: async () => {
    calls++;
    expect(stored().state).toBe('submitting');
    const ledger = JSON.parse(readFileSync(join(workspace, '.brainchain-work/meshy/credit-ledger.json'), 'utf8'));
    expect(ledger.bookedCredits).toBe(30);
    return Response.json({ result: TASK });
  } });
  expect(await driver.submit('office-v1', 100)).toMatchObject({ taskId: TASK, state: 'submitted' });
  expect(stored().taskId).toBe(TASK);
  await expect(driver.submit('office-v1', 100)).rejects.toThrow('already has a submission record');
  expect(calls).toBe(1);
});

test('a POST timeout remains uncertain and never permits an automatic repeat', async () => {
  let calls = 0;
  const driver = createOfficeMeshyDriver({ workspace, timeoutMs: 10, keyLoader: () => 'test-only-key', fetchFn: () => { calls++; return new Promise(() => {}); } });
  await expect(driver.submit('office-v1', 100)).rejects.toThrow('Credits stay reserved');
  expect(stored().state).toBe('uncertain');
  await expect(driver.submit('office-v1', 100)).rejects.toThrow('already has a submission record');
  expect(calls).toBe(1);
});

test('a credit cap refusal never reaches the paid API', async () => {
  const driver = createOfficeMeshyDriver({ workspace, keyLoader: () => 'test-only-key', fetchFn: () => { throw new Error('Paid API must not run'); } });
  await expect(driver.submit('office-v1', 29)).rejects.toThrow('> cap');
  expect(existsSync(join(workspace, '.brainchain-work/meshy/office-v1/task.json'))).toBe(false);
  await expect(driver.submit('../escape', 100)).rejects.toThrow('Invalid batch');
});

test('task and asset references cannot select another task, local host, or cleartext URL', () => {
  expect(validTaskId(TASK)).toBe(true);
  expect(validTaskId('../task')).toBe(false);
  for (const url of [`http://assets.meshy.ai/a/tasks/${TASK}/model.glb`, `https://localhost/tasks/${TASK}/model.glb`, `https://assets.meshy.ai/a/tasks/${OTHER}/model.glb`, `https://user@assets.meshy.ai/a/tasks/${TASK}/model.glb`]) {
    expect(() => validateAssetUrl(url, TASK)).toThrow();
  }
});

test('download accepts only its stored successful GLB and never forwards the API credential', async () => {
  let phase = 'submit';
  const driver = createOfficeMeshyDriver({ workspace, keyLoader: () => 'test-only-key', fetchFn: async (_url: string, options: RequestInit) => {
    if (phase === 'submit') return Response.json({ result: TASK });
    if (phase === 'status') return Response.json({ id: TASK, status: 'SUCCEEDED', progress: 100, model_urls: { glb: `https://assets.meshy.ai/a/tasks/${TASK}/model.glb?Expires=private` } });
    expect(options.headers).toBeUndefined();
    expect(options.redirect).toBe('manual');
    const bytes = Buffer.alloc(12); bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(12, 8);
    return new Response(bytes);
  } });
  await driver.submit('office-v1', 100);
  await expect(driver.download()).rejects.toThrow('Read task status');
  phase = 'status';
  expect(await driver.status()).toMatchObject({ taskId: TASK, status: 'SUCCEEDED' });
  phase = 'download';
  const result = await driver.download();
  expect(result.bytes).toBe(12);
  expect(JSON.stringify(result)).not.toContain('Expires');
  await expect(driver.download()).rejects.toThrow('already exists');
});
