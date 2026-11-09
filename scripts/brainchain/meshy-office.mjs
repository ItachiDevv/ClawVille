#!/usr/bin/env node
// Lead-only paid submit. Dry-run, status, and download never create a Meshy task.
// Reviewed 2026-11-09: https://docs.meshy.ai/en/api/multi-image-to-3d
// Price: https://docs.meshy.ai/en/api/pricing (standard geometry + N1 2K: 30 credits).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reserveSpend, updateSpendEntry, withFileLock, writeJsonAtomic } from '../hermes-pipeline/spend-ledger.mjs';

export const OFFICE_MESHY_CREDITS = 30;
export const OFFICE_MESHY_SETTINGS = Object.freeze({
  ai_model: 'meshy-7.1', geometry_resolution: 'standard', texture_model: 'meshy-n1',
  texture_resolution: '2k', topology: 'triangle', target_polycount: 12000,
  should_remesh: true, should_texture: true, enable_pbr: false,
  image_enhancement: false, target_formats: ['glb'],
});
const API = 'https://api.meshy.ai/openapi/v1/multi-image-to-3d';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VIEWS = ['front.png', 'back.png', '3q.png'];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function validTaskId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function buildOfficePayload(images) {
  if (!Array.isArray(images) || images.length !== 3) throw new Error('Three reviewed PNG views are required.');
  for (const image of images) {
    if (!Buffer.isBuffer(image) || image.length < 24 || image.length > MAX_IMAGE_BYTES
      || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG reference.');
    const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
    if (width < 32 || height < 32 || width * height > 178_956_970) throw new Error('Invalid reference dimensions.');
  }
  return { image_urls: images.map((image) => `data:image/png;base64,${image.toString('base64')}`), ...OFFICE_MESHY_SETTINGS };
}

export function validateAssetUrl(value, taskId) {
  if (!validTaskId(taskId)) throw new Error('Invalid stored task ID.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Meshy asset URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'assets.meshy.ai' || url.port || url.username || url.password
    || !url.pathname.includes(`/tasks/${taskId}/`) || !url.pathname.endsWith('.glb')) {
    throw new Error('Asset does not belong to the stored Meshy task.');
  }
  return url.href;
}

export function loadMeshyKey(env = process.env) {
  let value = env.MESHY_API_KEY;
  if (!value) {
    try {
      const line = readFileSync(join(homedir(), '.itachi-api-keys'), 'utf8').split(/\r?\n/)
        .find((entry) => /^\s*(?:export\s+)?MESHY_API_KEY=/.test(entry));
      value = line?.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    } catch { throw new Error('Meshy credential is unavailable.'); }
  }
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error('Meshy credential is unavailable.');
  return value.trim();
}

/** Deadline includes headers and the bounded stream. No redirect or retry follows. */
async function boundedRequest(fetchFn, url, options, maxBytes, timeoutMs) {
  const controller = new AbortController();
  let reader, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new Error('Request deadline reached.')); }, timeoutMs);
  });
  const operation = async () => {
    const response = await fetchFn(url, { ...options, redirect: 'manual', signal: controller.signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Meshy request refused (HTTP ${response.status}).`); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body.cancel(); throw new Error('Meshy response exceeds its byte limit.');
    }
    reader = response.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error('Meshy response exceeds its byte limit.'); }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, total);
  };
  try { return await Promise.race([operation(), deadline]); }
  catch { throw new Error('Meshy request failed, expired, or exceeded its byte limit.'); }
  finally { clearTimeout(timer); controller.abort(); if (reader) { void reader.cancel().catch(() => {}); } }
}

export function createOfficeMeshyDriver({ workspace = ROOT, fetchFn = globalThis.fetch, keyLoader = loadMeshyKey, timeoutMs = 30_000 } = {}) {
  const workRoot = join(resolve(workspace), '.brainchain-work', 'meshy');
  const ledgerPath = join(workRoot, 'credit-ledger.json');
  function paths(batch) {
    if (typeof batch !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(batch)) throw new Error('Invalid batch name.');
    const dir = join(workRoot, batch);
    return { dir, task: join(dir, 'task.json'), response: join(dir, 'response-private.json'), model: join(dir, 'model.glb') };
  }
  function payload() {
    const images = VIEWS.map((name) => {
      const path = join(resolve(workspace), 'docs/research/brainchain-2026-11-09/3d/refs', name);
      if (statSync(path).size > MAX_IMAGE_BYTES) throw new Error('Reference exceeds the image byte limit.');
      return readFileSync(path);
    });
    return buildOfficePayload(images);
  }
  function dryRun() {
    const request = payload();
    return { credits: OFFICE_MESHY_CREDITS, pricingReviewedAt: '2026-11-09', settings: OFFICE_MESHY_SETTINGS,
      views: VIEWS, requestHash: hash(JSON.stringify(request)), imageBytes: request.image_urls.map((url) => Buffer.from(url.split(',')[1], 'base64').length) };
  }
  function storedTask(p) {
    if (!existsSync(p.task)) throw new Error('No stored task. Submit requires the lead and a reserved budget.');
    const task = JSON.parse(readFileSync(p.task, 'utf8'));
    if (!validTaskId(task.taskId)) throw new Error('No confirmed task ID. Reconcile the original submission; never repeat its POST.');
    return task;
  }
  async function apiRequest(method, taskId, body) {
    const key = keyLoader();
    const bytes = await boundedRequest(fetchFn, taskId ? `${API}/${taskId}` : API,
      { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, 128 * 1024, timeoutMs);
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Meshy returned an unreadable task response.'); }
  }
  async function submit(batch = 'office-v1', cap = Number(process.env.MESHY_CREDIT_CAP)) {
    const p = paths(batch), request = payload();
    keyLoader(); // Refuse missing credentials before reserving credits.
    mkdirSync(p.dir, { recursive: true });
    return withFileLock(join(workRoot, 'submit.lock'), async () => {
      if (existsSync(p.task)) throw new Error('This batch already has a submission record. Inspect it; no second POST is allowed.');
      const reservation = await reserveSpend({ ledgerPath, amount: OFFICE_MESHY_CREDITS, cap,
        label: `brainchain-office:${batch}`, totalKey: 'bookedCredits',
        entry: { batch, taskId: null, state: 'reserved', pricingReviewedAt: '2026-11-09' } });
      const initial = { batch, state: 'submitting', reservationId: reservation.id, requestHash: hash(JSON.stringify(request)),
        reservedCredits: OFFICE_MESHY_CREDITS, submittedAt: new Date().toISOString(), taskId: null };
      writeJsonAtomic(p.task, initial);
      let taskId;
      try {
        const response = await apiRequest('POST', null, request);
        if (!validTaskId(response.result)) throw new Error('Invalid task ID.');
        taskId = response.result;
        // Persist the ID before any subsequent network request or polling.
        writeJsonAtomic(p.task, { ...initial, taskId, state: 'submitted' });
        await updateSpendEntry({ ledgerPath, id: reservation.id, totalKey: 'bookedCredits', patch: { taskId, state: 'submitted' } });
        return { taskId, state: 'submitted', reservedCredits: OFFICE_MESHY_CREDITS };
      } catch {
        writeJsonAtomic(p.task, { ...initial, taskId: taskId ?? null, state: taskId ? 'submitted' : 'uncertain' });
        throw new Error('Submission outcome needs review. Credits stay reserved. Inspect the stored record; never repeat this POST.');
      }
    });
  }
  async function status(batch = 'office-v1') {
    const p = paths(batch), task = storedTask(p);
    const response = await apiRequest('GET', task.taskId);
    if (response.id !== task.taskId || !['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED'].includes(response.status)) {
      throw new Error('Meshy task response does not match the stored task.');
    }
    writeJsonAtomic(p.response, response); // Signed URLs remain only in ignored local evidence.
    return { taskId: task.taskId, status: response.status,
      progress: typeof response.progress === 'number' ? response.progress : null,
      consumedCredits: typeof response.consumed_credits === 'number' ? response.consumed_credits : null };
  }
  async function download(batch = 'office-v1') {
    const p = paths(batch), task = storedTask(p);
    if (!existsSync(p.response)) throw new Error('Read task status before downloading its result.');
    const response = JSON.parse(readFileSync(p.response, 'utf8'));
    if (response.id !== task.taskId || response.status !== 'SUCCEEDED') throw new Error('The stored task has no successful result.');
    const url = validateAssetUrl(response.model_urls?.glb, task.taskId);
    return withFileLock(join(p.dir, 'download.lock'), async () => {
      if (existsSync(p.model)) throw new Error('Model already exists. Review it before any replacement.');
      const bytes = await boundedRequest(fetchFn, url, { method: 'GET', credentials: 'omit' }, MAX_MODEL_BYTES, timeoutMs);
      if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
        throw new Error('Meshy asset is not a complete GLB v2 file.');
      }
      const temporary = join(p.dir, `model-${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, p.model);
      return { taskId: task.taskId, bytes: bytes.length, sha256: hash(bytes), file: p.model };
    });
  }
  return { dryRun, submit, status, download };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, batch = 'office-v1'] = process.argv.slice(2);
  const driver = createOfficeMeshyDriver();
  try {
    if (!['dry-run', 'submit', 'status', 'download'].includes(command)) throw new Error('Usage: meshy-office.mjs <dry-run|submit|status|download> [batch]');
    const result = command === 'dry-run' ? driver.dryRun() : await driver[command](batch);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
