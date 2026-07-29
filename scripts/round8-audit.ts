#!/usr/bin/env bun
// Round 8 evidence: untouched default view first, then three forced-camera
// roster spot checks and one wide side view. Requires Chrome CDP on :9223 and
// the cold-started production bundle on :3001.
const CDP_PORT = 9223;
const APP_URL = 'http://localhost:3001/cove/table';
const outputDir = import.meta.dir;

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

const browserVersion = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json() as {
  webSocketDebuggerUrl: string;
};
const browserSocket = new WebSocket(browserVersion.webSocketDebuggerUrl);
const browserPending = new Map<number, Pending>();
let browserId = 1;
browserSocket.onmessage = (event) => {
  const message = JSON.parse(event.data.toString());
  const request = browserPending.get(message.id);
  if (!request) return;
  browserPending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
};
await new Promise<void>((resolve, reject) => {
  browserSocket.onopen = () => resolve();
  browserSocket.onerror = reject;
});
const browserCommand = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
  const id = browserId++;
  browserPending.set(id, { resolve, reject });
  browserSocket.send(JSON.stringify({ id, method, params }));
});
const target = await browserCommand('Target.createTarget', { url: 'about:blank' });
await new Promise((resolve) => setTimeout(resolve, 400));
const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json() as Array<{
  id: string;
  webSocketDebuggerUrl: string;
}>;
const tab = targets.find((candidate) => candidate.id === target.targetId)!;
browserSocket.close();

const socket = new WebSocket(tab.webSocketDebuggerUrl);
const pending = new Map<number, Pending>();
let nextId = 1;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data.toString());
  const request = pending.get(message.id);
  if (!request) return;
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 1000));
  return result.result?.value;
};

const browserErrors: string[] = [];
await command('Page.enable');
await command('Runtime.enable');
await command('Emulation.setDeviceMetricsOverride', {
  width: 1366,
  height: 768,
  deviceScaleFactor: 1,
  mobile: false,
});
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data.toString());
  if (message.method === 'Runtime.exceptionThrown') {
    browserErrors.push(message.params?.exceptionDetails?.text ?? 'runtime exception');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    browserErrors.push(message.params.args?.map((arg: any) => arg.value ?? arg.description).join(' ') ?? 'console error');
  }
});

await command('Page.addScriptToEvaluateOnNewDocument', { source: `
window.__cvAudit = { scenes: [], renderers: [] };
window.__THREE_DEVTOOLS__ = {
  dispatchEvent(ev) {
    try {
      const value = ev.detail;
      if (!value) return;
      if (value.isScene) window.__cvAudit.scenes.push(value);
      if (value.render && value.setSize) {
        window.__cvAudit.renderers.push(value);
        if (value.__cvRound8Patched) return;
        value.__cvRound8Patched = true;
        for (const method of ['render', 'renderAsync']) {
          if (typeof value[method] !== 'function') continue;
          const original = value[method].bind(value);
          value[method] = function (scene, camera) {
            const override = window.__cvCamOverride;
            if (override && camera?.isPerspectiveCamera) {
              window.__cvForcedFrames = (window.__cvForcedFrames || 0) + 1;
              camera.position.set(override.px, override.py, override.pz);
              camera.lookAt(override.tx, override.ty, override.tz);
              camera.updateMatrixWorld(true);
            }
            return original(scene, camera);
          };
        }
      }
    } catch (_) {}
  },
  addEventListener() {},
  removeEventListener() {},
};
` });

const waitForTable = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate(`Boolean(window.__cvAudit?.scenes?.some((scene) => scene.getObjectByName('holdem-seat-5')))`);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for the Round 8 table scene');
};
const screenshot = async (name: string) => {
  const result = await command('Page.captureScreenshot', { format: 'png' });
  await Bun.write(`${outputDir}/${name}.png`, Buffer.from(result.data, 'base64'));
  console.error(`shot: scripts/${name}.png`);
};
const navigate = async (url: string) => {
  await command('Page.navigate', { url });
  await waitForTable();
  await new Promise((resolve) => setTimeout(resolve, 9000));
};
const hideHud = () => evaluate(`(() => {
  const main = document.querySelector('main');
  if (!main) return false;
  for (let index = 1; index < main.children.length; index += 1) main.children[index].style.display = 'none';
  return true;
})()`);
const isolateSeat = (targetSeat: number | null) => evaluate(`(() => {
  const scenes = window.__cvAudit?.scenes ?? [];
  const scene = [...scenes].reverse().find((candidate) => candidate.getObjectByName('holdem-seat-5'));
  if (!scene) return false;
  for (let seat = 1; seat <= 5; seat += 1) {
    const group = scene.getObjectByName('holdem-seat-' + seat);
    if (group) group.visible = ${targetSeat === null ? 'true' : `seat === ${targetSeat}`};
  }
  return true;
})()`);
const setCamera = async (position: readonly number[], targetPosition: readonly number[]) => {
  await evaluate(`window.__cvCamOverride = {
    px:${position[0]}, py:${position[1]}, pz:${position[2]},
    tx:${targetPosition[0]}, ty:${targetPosition[1]}, tz:${targetPosition[2]}
  }; window.__cvForcedFrames = 0; 'ok'`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (!(await evaluate('window.__cvForcedFrames || 0'))) throw new Error('Forced secondary camera did not engage');
};

// PRIMARY: exact route, no query knob, no camera override, full HUD included.
await navigate(APP_URL);
const dealResult = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim().toUpperCase() === 'DEAL');
  if (!button) return 'no-deal:' + [...document.querySelectorAll('button')]
    .map((candidate) => candidate.textContent?.trim()).join('|');
  button.click();
  return 'clicked';
})()`);
console.error(`default-deal: ${dealResult}`);
for (let attempt = 0; attempt < 30; attempt += 1) {
  if (await evaluate("document.querySelectorAll('[data-testid^=holdem-seat-badge-]').length >= 5")) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
await new Promise((resolve) => setTimeout(resolve, 2500));
const defaultState = await evaluate(`JSON.stringify({
  url: location.href,
  cameraOverride: window.__cvCamOverride ?? null,
  hasTable: Boolean(window.__cvAudit?.scenes?.some((scene) => scene.getObjectByName('holdem-seat-5'))),
  overlay: Boolean(document.querySelector('[data-nextjs-dialog], .vite-error-overlay')),
  contentLength: document.body.innerText.trim().length,
  badges: [...document.querySelectorAll('[data-testid^=holdem-seat-badge-]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return { id: element.dataset.testid, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }),
})`);
console.error(`default-state: ${defaultState}`);
await screenshot('r8-default-view');

// SECONDARY: one chibi, the sampled Hermes path, and one rigless GLB.
const modelQuery = encodeURIComponent('eliza_chibi,hermes_female,lobster,milady_official_7,milady_official_4');
await navigate(`${APP_URL}?seatModels=${modelQuery}&seatCards=1`);
await hideHud();
const spots = [
  { key: 'chibi', seat: 1, x: -181.7, z: -64.1 },
  { key: 'hermes_female', seat: 2, x: -181.7, z: 64.1 },
  { key: 'lobster', seat: 3, x: -38.9, z: 128.2 },
] as const;
for (const spot of spots) {
  await isolateSeat(spot.seat);
  const length = Math.hypot(spot.x, spot.z);
  const outwardX = spot.x / length;
  const outwardZ = spot.z / length;
  const tangentX = -outwardZ;
  const tangentZ = outwardX;
  await setCamera(
    [spot.x - outwardX * 175, 138, spot.z - outwardZ * 175],
    [spot.x, 66, spot.z],
  );
  await screenshot(`r8-spot-${spot.key}-front`);
  await setCamera(
    [spot.x + tangentX * 165, 132, spot.z + tangentZ * 165],
    [spot.x, 62, spot.z],
  );
  await screenshot(`r8-spot-${spot.key}-side`);
}
await isolateSeat(null);
await setCamera([430, 205, -35], [0, 66, 20]);
await screenshot('r8-wide-side');

console.error(`browser-errors: ${JSON.stringify(browserErrors)}`);
await evaluate("window.__cvCamOverride = null; 'released'");
await fetch(`http://localhost:${CDP_PORT}/json/close/${tab.id}`).catch(() => null);
socket.close();
