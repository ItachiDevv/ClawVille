const EXPR = `(() => {
  const panels = Array.from(document.querySelectorAll("div")).filter(d => d.innerText?.includes("AUTONOMOUS") && d.innerText.includes("Buildings"));
  const hud = panels.length ? panels[panels.length - 1].innerText : "no hud";
  const lines = hud.split("\\n");
  const state = lines.find(l => l.startsWith("State:")) || "?";
  const buildings = lines.find(l => l.startsWith("Buildings:")) || "?";
  const failCount = (hud.match(/Can.t find a path/g) || []).length;
  const discoveredCount = (hud.match(/Discovered/g) || []).length;
  const enteredCount = (hud.match(/Entered|Arrived/g) || []).length;
  return {state, buildings, failCount, discoveredCount, enteredCount, tail: lines.slice(-6).join(" | ")};
})()`;

import { spawnSync } from 'node:child_process';
for (let i = 1; i <= 5; i++) {
  await new Promise(r => setTimeout(r, 6000));
  const res = spawnSync('bun', ['run', 'C:/Users/newma/.claude/skills/browser-live/cdp-eval.ts', EXPR, 'clawville.world'], { encoding: 'utf8' });
  console.log(`--- tick ${i} ---`);
  console.log(res.stdout);
  if (res.stderr) console.error(res.stderr);
}
