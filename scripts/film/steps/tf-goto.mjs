export default async ({ page, goto, log, sleep, screenshotDom }) => {
  const t0 = Date.now();
  await goto('https://staging.clawville.world/trading-floor');
  let text = '';
  for (let i = 0; i < 60; i++) {
    text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
    if (!/dropping in|loading/i.test(text) && text.length > 50) break;
    await sleep(500);
  }
  log(`after ${Date.now() - t0} ms url=${page.url()} title=${await page.title()}`);
  log(`text=${text.slice(0, 700)}`);
  await sleep(3000);
  await screenshotDom('tf-loggedout');
};
