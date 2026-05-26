#!/usr/bin/env bun
// Probe 7: inspect THREE globals + try PropertyBinding.findNode + check clip data

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
if (!page) { console.error('no tab'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

async function evalExpr(expr, reqId) {
  return new Promise(resolve => {
    const handler = e => {
      const m = JSON.parse(e.data);
      if (m.id === reqId) { ws.removeEventListener('message', handler); resolve(m); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({
      id: reqId,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true, timeout: 20000 }
    }));
  });
}

const phaseA = `
(() => {
  const THREE = window.__THREE__;
  const keys = THREE ? Object.keys(THREE).filter(k => /AnimationMixer|PropertyBinding|AnimationClip|AnimationAction/i.test(k)) : [];
  const hasPropertyBinding = !!THREE?.PropertyBinding;
  return { threeKeys: keys, hasPropertyBinding, threeAnimationMixer: !!THREE?.AnimationMixer };
})()
`;
console.log('--- THREE globals sanity ---');
const rA = await evalExpr(phaseA, 1);
console.log(JSON.stringify(rA.result.result.value, null, 2));

// Patch: install a mixer tick observer by monkey-patching AnimationMixer.prototype.update
const phaseB = `
(() => {
  const THREE = window.__THREE__;
  if (!THREE?.AnimationMixer) return { err: 'no AnimationMixer' };

  if (!window.__mixerTickProbe) {
    window.__mixerTickProbe = {
      calls: 0,
      totalTime: 0,
      lastDelta: 0,
      lastT: 0,
      mixersSeen: new Set(),
      mixerDetails: [],
    };
    const orig = THREE.AnimationMixer.prototype.update;
    THREE.AnimationMixer.prototype.update = function(delta) {
      const probe = window.__mixerTickProbe;
      probe.calls++;
      probe.lastDelta = delta;
      probe.lastT = this.time;
      probe.totalTime += delta;
      if (!probe.mixersSeen.has(this)) {
        probe.mixersSeen.add(this);
        probe.mixerDetails.push({
          rootName: this._root?.name || this._root?.type,
          actionsLen: this._actions?.length,
          bindingsLen: this._bindings?.length,
          timeScale: this.timeScale,
          firstActionName: this._actions?.[0]?._clip?.name,
          firstActionEnabled: this._actions?.[0]?.enabled,
          firstActionWeight: this._actions?.[0]?.weight,
          firstActionIsRunning: typeof this._actions?.[0]?.isRunning === 'function' ? this._actions[0].isRunning() : null,
          firstActionPaused: this._actions?.[0]?.paused,
          firstClipDuration: this._actions?.[0]?._clip?.duration,
          firstClipTracksLen: this._actions?.[0]?._clip?.tracks?.length,
          // Inspect first track to see if keyframes look valid
          firstTrackName: this._actions?.[0]?._clip?.tracks?.[0]?.name,
          firstTrackTimesLen: this._actions?.[0]?._clip?.tracks?.[0]?.times?.length,
          firstTrackValuesLen: this._actions?.[0]?._clip?.tracks?.[0]?.values?.length,
          // First binding: is it bound to the right node?
          firstBindingNodeName: this._bindings?.[0]?.binding?.node?.name,
          firstBindingParsedName: this._bindings?.[0]?.binding?.parsedPath?.nodeName,
          firstBindingRootName: this._bindings?.[0]?.binding?.rootNode?.name,
          firstBindingTargetName: this._bindings?.[0]?.binding?.targetObject?.constructor?.name,
          firstBindingPropertyName: this._bindings?.[0]?.binding?.propertyName,
          firstBindingValid: !!(this._bindings?.[0]?.binding?.node),
        });
      }
      return orig.call(this, delta);
    };
  }
  return { installed: true };
})()
`;
console.log('\n--- Install mixer tick probe ---');
const rB = await evalExpr(phaseB, 2);
console.log(JSON.stringify(rB.result.result.value, null, 2));

// Wait 2s for ticks
await new Promise(r => setTimeout(r, 2500));

const phaseC = `
(() => {
  const p = window.__mixerTickProbe;
  if (!p) return { err: 'no probe' };
  return {
    calls: p.calls,
    totalTime: p.totalTime,
    lastDelta: p.lastDelta,
    lastT: p.lastT,
    mixerCount: p.mixersSeen.size,
    mixerDetails: p.mixerDetails,
  };
})()
`;
console.log('\n--- Mixer tick probe results ---');
const rC = await evalExpr(phaseC, 3);
if (rC?.result?.exceptionDetails) console.error(JSON.stringify(rC.result.exceptionDetails, null, 2));
else console.log(JSON.stringify(rC.result.result.value, null, 2));

ws.close();
