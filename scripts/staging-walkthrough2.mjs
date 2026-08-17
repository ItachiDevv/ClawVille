/** Phase 2: private-table create → join code → sit → live hand → walk away,
 *  plus one real blackjack hand. Fixes phase-1 selector bugs (exact CTA label,
 *  scoped seeded-agents stepper). */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import puppeteer from "puppeteer-core";

const BASE = "https://staging.clawville.world";
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const outDir = path.resolve(import.meta.dirname);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt2-chrome-"));
const EMAIL = process.env.WT_EMAIL;
const PASSWORD = process.env.WT_PASSWORD;

const verdict = { steps: [], profileDir };
const step = (n, ok, d = "") => {
  verdict.steps.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (p, n) => p.screenshot({ path: path.join(outDir, `wt2-${n}.png`) });

/** Click button by EXACT trimmed text (case-insensitive). */
async function clickExact(page, text) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim().toLowerCase() === t.toLowerCase() && !b.disabled,
    );
    if (el) { el.click(); return true; }
    return false;
  }, text);
}
async function clickContains(page, text) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.toLowerCase().includes(t.toLowerCase()) && !b.disabled,
    );
    if (el) { el.click(); return true; }
    return false;
  }, text);
}
const hasText = (page, t) =>
  page.evaluate((x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()), t);

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: "new",
  userDataDir: profileDir,
  args: ["--no-first-run", "--disable-extensions", "--window-size=1440,900", "--use-angle=swiftshader"],
  defaultViewport: { width: 1440, height: 900 },
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);

  // Login
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', EMAIL);
  await page.type('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45_000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(4000);
  step("login", !page.url().includes("/login"));

  // ── Private create with 2 seeded bots ────────────────────────────────────
  await page.goto(`${BASE}/cove/table`, { waitUntil: "networkidle2" });
  await sleep(6000);
  await clickExact(page, "Create Table");
  await sleep(1200);
  await clickExact(page, "Private table");
  await sleep(1000);
  await page.evaluate(() => {
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const byLabel = (frag) => {
      const lab = [...document.querySelectorAll("label")].find((l) =>
        l.textContent.toLowerCase().includes(frag),
      );
      const id = lab?.getAttribute("for");
      return id ? document.getElementById(id) : lab?.querySelector("input");
    };
    setVal(byLabel("buy-in"), "200");
    setVal(byLabel("small blind"), "10");
    setVal(byLabel("big blind"), "20");
  });
  // Seeded agents +2: find the stepper INSIDE the container whose heading says
  // "seeded agents"; click its "+" twice.
  for (let i = 0; i < 2; i++) {
    const bumped = await page.evaluate(() => {
      const heads = [...document.querySelectorAll("*")].filter(
        (e) => e.children.length === 0 && /seeded agents/i.test(e.textContent || ""),
      );
      for (const h of heads) {
        let node = h;
        for (let up = 0; up < 5 && node; up++) {
          const plus = [...node.querySelectorAll("button")].find(
            (b) => b.textContent.trim() === "+" && !b.disabled,
          );
          if (plus) { plus.click(); return true; }
          node = node.parentElement;
        }
      }
      return false;
    });
    if (!bumped) break;
    await sleep(300);
  }
  await shot(page, "create-filled");
  const submitted = await clickExact(page, "Create private table");
  step("create private table clicked", submitted);
  await sleep(6000);
  await shot(page, "after-create");
  const codeShown = (await hasText(page, "join code")) || (await hasText(page, "Share this"));
  const code = await page.evaluate(() => {
    const m = document.body.innerText.match(/\b[A-Z0-9]{4,12}\b(?=[\s\S]{0,400}Copy)/);
    return m ? m[0] : null;
  });
  verdict.joinCode = code;
  step("one-time join code shown", codeShown, code ? `code=${code}` : "not parsed");

  const entered = (await clickContains(page, "Enter table")) || (await clickContains(page, "Enter"));
  step("enter table", entered);
  await sleep(12_000);
  await shot(page, "room");

  // ── Sit + play ───────────────────────────────────────────────────────────
  const sat = await clickContains(page, "Sit down");
  step("sit down", sat);
  await sleep(3000);
  await clickContains(page, "Buy in");
  await clickContains(page, "Confirm");
  await sleep(8000);
  await shot(page, "seated");

  let acted = 0;
  let sawBoard = false;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const body = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/pot awarded|wins the pot|showdown|you win|hand complete/.test(body)) break;
    if (/pot\b/.test(body)) sawBoard = true;
    for (const label of ["Check", "Call", "Fold"]) {
      if (await clickContains(page, label)) {
        acted++;
        console.log(`action #${acted}: ${label}`);
        await shot(page, `act-${acted}`);
        break;
      }
    }
    await sleep(2500);
  }
  await shot(page, "hand-end");
  step("live hand played", acted > 0, `${acted} actions, boardSeen=${sawBoard}`);

  const walked = await clickContains(page, "Walk Away");
  await sleep(3000);
  const cashCopy = (await hasText(page, "cashing out")) || (await hasText(page, "cashed out"));
  await shot(page, "walkaway");
  step("walk away + cash-out copy", walked && cashCopy, `walked=${walked} copy=${cashCopy}`);

  // ── One real blackjack hand: deal → stand → settle ───────────────────────
  await page.goto(`${BASE}/cove/blackjack`, { waitUntil: "networkidle2" });
  await sleep(9000);
  const balBefore = await page.evaluate(() => {
    const m = document.body.innerText.match(/BALANCE\s+([\d,]+)\s+VCLAW/i);
    return m ? m[1] : null;
  });
  await clickContains(page, "5 vCLAW");
  await sleep(800);
  const dealt = await clickExact(page, "Deal");
  step("blackjack deal", dealt, `balance before=${balBefore}`);
  await sleep(6000);
  await shot(page, "bj-mid");
  // Stand if offered (may auto-settle on natural).
  await clickExact(page, "Stand");
  await sleep(8000);
  await shot(page, "bj-end");
  const balAfter = await page.evaluate(() => {
    const m = document.body.innerText.match(/BALANCE\s+([\d,]+)\s+VCLAW/i);
    return m ? m[1] : null;
  });
  step("blackjack settled", balAfter !== null, `balance ${balBefore} -> ${balAfter}`);
} catch (err) {
  step("aborted", false, String(err?.message || err));
} finally {
  fs.writeFileSync(path.join(outDir, "wt2-verdict.json"), JSON.stringify(verdict, null, 2));
  await browser.close();
  console.log("PROFILE_DIR=" + profileDir);
}
const failed = verdict.steps.filter((s) => !s.ok);
console.log(`\nVERDICT: ${verdict.steps.length - failed.length}/${verdict.steps.length} pass`);
process.exit(failed.length ? 1 : 0);
