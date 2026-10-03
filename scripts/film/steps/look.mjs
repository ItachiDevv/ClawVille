export default async ({ page, log, sleep, screenshotDom }) => {
  await sleep(Number(process.env.LOOK_WAIT || 4000));
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  log(`url=${page.url()} len=${t.length}`);
  log(`text=${t.slice(0, 1600)}`);
  log(`verifyBanner=${/verify your email|verify email|check your inbox/i.test(t)} reefRookie=${/reef ?rookie/i.test(t)}`);
  const ls = await page.evaluate(() => Object.keys(localStorage).sort().join(','));
  log(`localStorage keys=${ls}`);
  await screenshotDom(process.env.LOOK_NAME || 'look');
};
