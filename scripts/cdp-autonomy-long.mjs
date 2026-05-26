// Long-running autonomy monitor. Proves pathfinding fix by counting
// path-failure messages over 90s of ticks (autonomy setInterval still
// runs at 2Hz even in background tabs — only RAF/pet movement is frozen).

const EXPR = `(() => {
  const panels = Array.from(document.querySelectorAll("div")).filter(d => d.innerText?.includes("AUTONOMOUS") && d.innerText.includes("Buildings"));
  const hud = panels.length ? panels[panels.length - 1].innerText : "no hud";
  return {
    failCount: (hud.match(/Can.t find/g) || []).length,
    discoveredCount: (hud.match(/Discovered/g) || []).length,
    headingCount: (hud.match(/Heading to/g) || []).length,
    state: (hud.match(/State: (\\w+)/) || [])[1],
    buildings: (hud.match(/Buildings: (\\d+)/) || [])[1],
    hudLen: hud.length,
  };
})()`;

import { spawnSync } from 'node:child_process';
const start = Date.now();
for (let i = 1; i <= 15; i++) {
  await new Promise(r => setTimeout(r, 6000));
  const res = spawnSync('bun', ['run', 'C:/Users/newma/.claude/skills/browser-live/cdp-eval.ts', EXPR, 'clawville.world'], { encoding: 'utf8' });
  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`t=${elapsed}s ${res.stdout.trim()}`);
  if (res.stderr && !res.stderr.includes('[cdp-eval]')) console.error(res.stderr);
}
