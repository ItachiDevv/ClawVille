#!/usr/bin/env bun
// Full selectable-avatar Hold'em seating matrix. Batches five registry keys
// through the localhost-only ?seatModels= override, then captures every model
// from table-facing FRONT and tangent SIDE cameras. Evidence lands beside this
// script as r7-roster-<key>-{front,side}.png.
import {
  MODEL_REGISTRY,
  type ModelKey,
  type ModelRegistryEntry,
} from '../apps/web/src/lib/three/agent-model-registry';

const PORT = 9223;
const APP_URL = 'http://localhost:3001/cove/table';
const dir = import.meta.dir;
const seats = [
  { seat: 1, x: -84.1, z: -60.9 },
  { seat: 2, x: -149.35, z: -5.8 },
  { seat: 3, x: -126.15, z: 72.5 },
  { seat: 4, x: 84.1, z: -60.9 },
  { seat: 5, x: 149.35, z: -5.8 },
] as const;
const selectableKeys = (Object.entries(MODEL_REGISTRY) as [ModelKey, ModelRegistryEntry][])
  .filter(([, entry]) => !entry.pickerHidden)
  .map(([key]) => key);
const requestedKeys = process.argv.slice(2).filter((key): key is ModelKey => key in MODEL_REGISTRY);
const modelKeys = requestedKeys.length ? requestedKeys : selectableKeys;

const browserVersion = await (await fetch(`http://localhost:${PORT}/json/version`)).json() as {
  webSocketDebuggerUrl: string;
};
const browserSocket = new WebSocket(browserVersion.webSocketDebuggerUrl);
const browserPending = new Map<number, (value: any) => void>();
let browserId = 1;
browserSocket.onmessage = (event) => {
  const message = JSON.parse(event.data.toString());
  if (message.id && browserPending.has(message.id)) {
    browserPending.get(message.id)!(message.result);
    browserPending.delete(message.id);
  }
};
await new Promise<void>((resolve, reject) => {
  browserSocket.onopen = () => resolve();
  browserSocket.onerror = reject;
});
const browserCommand = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve) => {
  const id = browserId++;
  browserPending.set(id, resolve);
  browserSocket.send(JSON.stringify({ id, method, params }));
});
const target = await browserCommand('Target.createTarget', { url: 'about:blank' });
await new Promise((resolve) => setTimeout(resolve, 400));
const tabs = await (await fetch(`http://localhost:${PORT}/json`)).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
const tab = tabs.find((candidate) => candidate.id === target.targetId)!;
browserSocket.close();

const socket = new WebSocket(tab.webSocketDebuggerUrl);
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nextId = 1;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data.toString());
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id)!;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
};
await new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = reject;
});
const command = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression: string): Promise<any> => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
  return result.result?.value;
};

await command('Page.enable');
await command('Runtime.enable');
await command('Page.addScriptToEvaluateOnNewDocument', { source: `
window.__cvAudit = { scenes: [], renderers: [] };
window.__THREE_DEVTOOLS__ = {
  dispatchEvent(ev) {
    try {
      const d = ev.detail;
      if (!d) return;
      if (d.isScene) window.__cvAudit.scenes.push(d);
      if (d.render && d.setSize) {
        window.__cvAudit.renderers.push(d);
        if (!d.__cvPatched) {
          d.__cvPatched = true;
          for (const method of ['render', 'renderAsync']) {
            if (typeof d[method] !== 'function') continue;
            const original = d[method].bind(d);
            d[method] = function (scene, camera) {
              const override = window.__cvCamOverride;
              if (override && camera && camera.isPerspectiveCamera) {
                window.__cvForcedFrames = (window.__cvForcedFrames || 0) + 1;
                camera.position.set(override.px, override.py, override.pz);
                camera.lookAt(override.tx, override.ty, override.tz);
                camera.updateMatrixWorld(true);
              }
              return original(scene, camera);
            };
          }
        }
      }
    } catch (_) {}
  },
  addEventListener() {}, removeEventListener() {},
};
` });

const waitForScene = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await evaluate(`Boolean(window.__cvAudit?.scenes?.some((scene) => scene.getObjectByName('holdem-seat-5')))`);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for Holdem table seats');
};

const hideHud = () => evaluate(`(() => {
  const main = document.querySelector('main');
  if (!main) return false;
  for (let i = 1; i < main.children.length; i += 1) main.children[i].style.display = 'none';
  return true;
})()`);

const isolateSeat = (targetSeat: number) => evaluate(`(() => {
  const scene = window.__cvAudit?.scenes?.[0];
  if (!scene) return false;
  for (let seat = 1; seat <= 5; seat += 1) {
    const group = scene.getObjectByName('holdem-seat-' + seat);
    if (group) group.visible = seat === ${targetSeat};
  }
  return true;
})()`);

const setCamera = async (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
  await evaluate(`window.__cvCamOverride = { px:${px}, py:${py}, pz:${pz}, tx:${tx}, ty:${ty}, tz:${tz} }; window.__cvForcedFrames = 0; 'ok'`);
  await new Promise((resolve) => setTimeout(resolve, 650));
  if (!(await evaluate('window.__cvForcedFrames || 0'))) throw new Error('Forced camera did not engage');
};

const screenshot = async (name: string) => {
  const result = await command('Page.captureScreenshot', { format: 'png' });
  await Bun.write(`${dir}/${name}.png`, Buffer.from(result.data, 'base64'));
  console.error(`shot: ${name}.png`);
};

for (let offset = 0; offset < modelKeys.length; offset += seats.length) {
  const batch = modelKeys.slice(offset, offset + seats.length);
  const url = `${APP_URL}?seatModels=${encodeURIComponent(batch.join(','))}`;
  await command('Page.navigate', { url });
  await waitForScene();
  await new Promise((resolve) => setTimeout(resolve, 9000));
  await hideHud();

  for (let index = 0; index < batch.length; index += 1) {
    const key = batch[index]!;
    const seat = seats[index]!;
    await isolateSeat(seat.seat);
    const length = Math.hypot(seat.x, seat.z);
    const outwardX = seat.x / length;
    const outwardZ = seat.z / length;
    const tangentX = -outwardZ;
    const tangentZ = outwardX;
    const radius = 150;
    await setCamera(
      seat.x - outwardX * 70 + tangentX * 120, 132,
      seat.z - outwardZ * 70 + tangentZ * 120,
      seat.x, 56, seat.z,
    );
    await screenshot(`r7-roster-${key}-front`);
    await setCamera(
      seat.x + tangentX * radius, 126, seat.z + tangentZ * radius,
      seat.x, 58, seat.z,
    );
    await screenshot(`r7-roster-${key}-side`);
  }
}

await evaluate("window.__cvCamOverride = null; 'released'");
await fetch(`http://localhost:${PORT}/json/close/${tab.id}`).catch(() => null);
socket.close();
console.error(`done: ${modelKeys.length} selectable avatars, ${modelKeys.length * 2} captures`);
