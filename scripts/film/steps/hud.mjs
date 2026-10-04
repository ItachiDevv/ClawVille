// HUD=off hides every DOM element except the WebGPU canvas (a clean plate of the real 3D frame; nothing is added).
// HUD=on removes the style again. The style survives until the next reload; use it only for establishing shots.
export default async ({ page, log, screenshotDom }) => {
  const off = (process.env.HUD || 'off') === 'off';
  await page.evaluate((off) => {
    document.getElementById('film-hud-off')?.remove();
    if (!off) return;
    const s = document.createElement('style');
    s.id = 'film-hud-off';
    s.textContent = 'body *:not(:has(canvas)):not(canvas){opacity:0 !important;pointer-events:none !important}';
    document.head.appendChild(s);
  }, off);
  log(`hud ${off ? 'off' : 'on'}`);
  if (process.env.SHOT) await screenshotDom(process.env.SHOT);
};
