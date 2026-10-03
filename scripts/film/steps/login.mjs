// Signs the film account into the rig profile. Never logs the email, password or cookie.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ACCOUNT = join(process.cwd(), '.film', 'accounts', 'film.json');

export default async ({ page, goto, log, sleep }) => {
  const acct = JSON.parse(readFileSync(ACCOUNT, 'utf8'));
  await goto('https://staging.clawville.world/login');
  await page.locator('input[type=email]').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('input[type=email]').first().fill(acct.email);
  await page.locator('input[type=password]').first().fill(acct.password);
  log('credentials typed (values not logged)');
  await page.getByRole('button', { name: /enter clawville/i }).first().click();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (!page.url().includes('/login')) break;
  }
  log(`after submit url=${page.url()}`);
  const err = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/(invalid|incorrect|error|failed|too many)[^\n]{0,120}/i);
    return m ? m[0] : '';
  });
  if (err) log(`page error text: ${err}`);
  const me = await page.evaluate(async () => {
    const r = await fetch('https://api-staging.clawville.world/api/auth/me', { credentials: 'include' }).catch(() => null);
    if (!r) return { status: 'fetch failed' };
    const j = await r.json().catch(() => ({}));
    const u = j.user || j;
    return { status: r.status, username: u.username ?? null, emailVerified: u.emailVerified ?? u.email_verified ?? null, avatarName: j.avatar?.name ?? u.avatar?.name ?? null };
  });
  log(`auth/me ${JSON.stringify(me)}`);
};
