// cold-load-scene-leak-probe.mjs — slice-D watchdog single (spec §6): a cold
// boot of a NON-world scene must fetch ZERO world-building bytes (the
// building byte-warms key off BOOT_CORE_PRESENTED, which never stamps
// outside the world). Boots the target, waits, and reports building-GLB
// resource entries.
//
// usage: bun cold-load-scene-leak-probe.mjs <cdp-ws-url> <target-url> <wait-ms>

const [wsUrl, targetUrl, waitMsRaw] = process.argv.slice(2);
if (!wsUrl || !targetUrl) {
  console.error("usage: bun cold-load-scene-leak-probe.mjs <cdp-ws-url> <target-url> [wait-ms]");
  process.exit(2);
}
const waitMs = Number(waitMsRaw) || 25_000;

let msgId = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};

await new Promise((res, rej) => {
  ws.onopen = res;
  setTimeout(() => rej(new Error("ws open timeout")), 10_000);
});
let session = null;
if (wsUrl.includes("/devtools/browser")) {
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const att = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  session = att.sessionId;
}
await send("Page.enable", {}, session);
await send("Runtime.enable", {}, session);
await send("Page.navigate", { url: targetUrl }, session);
await new Promise((r) => setTimeout(r, waitMs));
const res = await send(
  "Runtime.evaluate",
  {
    expression: `JSON.stringify({
      buildingGlbs: performance.getEntriesByType('resource')
        .map((r) => r.name)
        .filter((n) => /models\\/(pineapple-house|chum-bucket|krusty-krab|salty-spitoon|boating-school|patty-building|building-lighthouse|arcade\\/claw-arcade-exterior|cove\\/cove-exterior|patricks-rock|squidward-house)/.test(n)),
      totalResources: performance.getEntriesByType('resource').length,
    })`,
    returnByValue: true,
  },
  session,
);
const parsed = JSON.parse(res?.result?.value ?? "{}");
console.log(JSON.stringify(parsed, null, 1));
// cove-exterior is legitimately fetched INSIDE the cove scene? No — the cove
// INTERIOR is a different asset; the exterior building GLB belongs to the
// world. Zero of the listed urls may appear.
process.exit((parsed.buildingGlbs ?? []).length === 0 ? 0 : 1);
