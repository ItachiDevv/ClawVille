/**
 * Agent-driven staging walkthrough of the cove poker ring + lobby.
 * Drives the DEPLOYED staging build (no mocks) with the staging test account.
 * Isolated Chrome profile under the OS temp dir; cleaned up by the caller.
 *
 * Usage: WT_EMAIL=... WT_PASSWORD=... bun run scripts/staging-walkthrough.mjs
 * Screenshots + a JSON verdict land in scripts/wt-*.png / scripts/wt-verdict.json.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import puppeteer from "puppeteer-core";

const BASE = "https://staging.clawville.world";
const chromePath =
  process.env.WT_CHROME ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const outDir = path.resolve(import.meta.dirname);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-chrome-"));
const EMAIL = process.env.WT_EMAIL;
const PASSWORD = process.env.WT_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("WT_EMAIL / WT_PASSWORD required");
  process.exit(2);
}

const verdict = { steps: [], profileDir };
function step(name, ok, detail = "") {
  verdict.steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `wt-${name}.png`) });
}

/** Click the button whose visible text matches (case-insensitive substring). */
async function clickByText(page, text, tag = "button") {
  const ok = await page.evaluate(
    (t, tg) => {
      const els = [...document.querySelectorAll(tg)];
      const el = els.find(
        (e) =>
          e.textContent &&
          e.textContent.toLowerCase().includes(t.toLowerCase()) &&
          !e.disabled,
      );
      if (el) {
        el.click();
        return true;
      }
      return false;
    },
    text,
    tag,
  );
  return ok;
}

async function textOnPage(page, t) {
  return page.evaluate(
    (x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()),
    t,
  );
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: "new",
  userDataDir: profileDir,
  args: [
    "--no-first-run",
    "--disable-extensions",
    "--window-size=1440,900",
    "--use-angle=swiftshader",
  ],
  defaultViewport: { width: 1440, height: 900 },
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);

  // ── 1. Login ──────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', EMAIL, { delay: 10 });
  await page.type('input[type="password"]', PASSWORD, { delay: 10 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45_000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(4000);
  const loggedIn = !page.url().includes("/login");
  step("login", loggedIn, page.url());
  if (!loggedIn) throw new Error("login failed");

  // ── 2. Lobby renders with real tables ────────────────────────────────────
  await page.goto(`${BASE}/cove/table`, { waitUntil: "networkidle2" });
  await sleep(6000);
  const hasLiveTables = await textOnPage(page, "Live Tables");
  const hasVclaw = await textOnPage(page, "vCLAW blinds");
  await shot(page, "lobby");
  step("lobby renders", hasLiveTables && hasVclaw);

  // ── 3. Create tab shows the RESTORED ladder ──────────────────────────────
  await clickByText(page, "Create Table");
  await sleep(1500);
  const ladderOk =
    (await textOnPage(page, "250/500 vCLAW blinds")) &&
    (await textOnPage(page, "50/100 vCLAW blinds")) &&
    (await textOnPage(page, "10/20 vCLAW blinds")) &&
    !(await textOnPage(page, "1/2 vCLAW blinds"));
  await shot(page, "create-ladder");
  step("create tab shows restored ladder (no 1/2)", ladderOk);

  // ── 4. Create a PRIVATE table with seeded bots — real join code ──────────
  await clickByText(page, "Private table");
  await sleep(1000);
  // Fill custom stakes: buy-in 200, SB 10, BB 20 (matches low tier semantics).
  const filled = await page.evaluate(() => {
    const setVal = (el, v) => {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll("input")].filter(
      (i) => i.type === "number" || i.inputMode === "numeric" || /buy|blind/i.test(i.id + i.name + (i.getAttribute("aria-label") || "")),
    );
    const byLabel = (frag) => {
      const lab = [...document.querySelectorAll("label")].find((l) =>
        l.textContent.toLowerCase().includes(frag),
      );
      if (!lab) return null;
      const id = lab.getAttribute("for");
      return id ? document.getElementById(id) : lab.querySelector("input");
    };
    const buy = byLabel("buy-in") || inputs[0];
    const sb = byLabel("small blind") || inputs[1];
    const bb = byLabel("big blind") || inputs[2];
    if (!buy || !sb || !bb) return false;
    setVal(buy, "200");
    setVal(sb, "10");
    setVal(bb, "20");
    return true;
  });
  if (!filled) {
    await shot(page, "create-private-fail");
    step("private stakes filled", false, "inputs not found");
  } else {
    // Bump seeded agents to 2 so the table can deal against bots.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => {
        const grp = [...document.querySelectorAll("fieldset, div")].find((d) =>
          /seeded agents/i.test(d.textContent || ""),
        );
        const plus = grp && [...grp.querySelectorAll("button")].find((b) => b.textContent.trim() === "+");
        plus?.click();
      });
      await sleep(200);
    }
    await shot(page, "create-private-filled");
    const clicked = await clickByText(page, "Create");
    step("private create submitted", clicked);
    await sleep(5000);
    const codeShown = await textOnPage(page, "join code");
    await shot(page, "join-code");
    // Extract the code for the record (safe to log — throwaway table).
    const code = await page.evaluate(() => {
      const m = document.body.innerText.match(/\b[A-Z0-9]{4,10}\b(?=[\s\S]{0,300}Copy code)/);
      return m ? m[0] : null;
    });
    step("one-time join code shown", codeShown, code ? `code=${code}` : "code not parsed");
    verdict.joinCode = code;
    // Enter the table.
    const entered = (await clickByText(page, "Enter table")) || (await clickByText(page, "Enter"));
    step("enter table clicked", entered);
    await sleep(10_000);
  }

  // ── 5. Sit down + play a real hand ───────────────────────────────────────
  await shot(page, "room-before-sit");
  const satPrompt = await clickByText(page, "Sit down");
  step("sit down clicked", satPrompt);
  await sleep(4000);
  // A buy-in confirm may exist; click any primary confirm containing 'Sit' or 'Buy'.
  await clickByText(page, "Buy in");
  await clickByText(page, "Confirm");
  await sleep(6000);
  await shot(page, "seated");

  // Play until the hand settles or 90s: prefer Check, then Call, then Fold.
  let acted = 0;
  let settled = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (
      (await textOnPage(page, "pot awarded")) ||
      (await textOnPage(page, "showdown")) ||
      (await textOnPage(page, "wins the pot")) ||
      (await textOnPage(page, "you win"))
    ) {
      settled = true;
      break;
    }
    for (const label of ["Check", "Call", "Fold"]) {
      const did = await clickByText(page, label);
      if (did) {
        acted++;
        console.log(`action: ${label} (#${acted})`);
        await shot(page, `action-${acted}`);
        break;
      }
    }
    await sleep(2500);
  }
  await shot(page, "hand-end");
  step("played live hand", acted > 0, `${acted} actions, settled=${settled}`);

  // ── 6. Walk Away → queued cash-out copy ──────────────────────────────────
  const walked = await clickByText(page, "Walk Away");
  await sleep(2500);
  const queuedCopy =
    (await textOnPage(page, "cashing out")) || (await textOnPage(page, "cashed out"));
  await shot(page, "walk-away");
  step("walk away", walked, `queued/settled copy=${queuedCopy}`);

  // ── 7. Blackjack + baccarat rooms load ───────────────────────────────────
  for (const room of ["blackjack", "baccarat"]) {
    await page.goto(`${BASE}/cove/${room}`, { waitUntil: "networkidle2" });
    await sleep(9000);
    const bodyLen = await page.evaluate(() => document.body.innerText.length);
    await shot(page, `room-${room}`);
    step(`${room} room loads`, bodyLen > 20, `${bodyLen} chars of UI`);
  }

  // ── 8. Logged-out practice: no Deal button ───────────────────────────────
  const guest = await browser.createBrowserContext();
  const gp = await guest.newPage();
  await gp.setViewport({ width: 1440, height: 900 });
  await gp.goto(`${BASE}/cove/table`, { waitUntil: "networkidle2" });
  await sleep(10_000);
  const guestHasDeal = await gp.evaluate(() =>
    [...document.querySelectorAll("button")].some((b) => /^deal$/i.test(b.textContent.trim())),
  );
  const guestBody = await gp.evaluate(() => document.body.innerText.toLowerCase());
  await gp.screenshot({ path: path.join(outDir, "wt-guest-practice.png") });
  step("guest surface has NO Deal button", !guestHasDeal);
  step(
    "guest sees lobby or practice",
    guestBody.includes("live tables") || guestBody.includes("practice") || guestBody.includes("sit down"),
  );
  await guest.close();

  // ── 9. Viewport sweep on the lobby ───────────────────────────────────────
  const sizes = [
    [390, 844],
    [844, 390],
    [744, 1133],
    [1133, 744],
    [820, 1180],
    [1024, 1366],
    [1366, 1024],
  ];
  await page.goto(`${BASE}/cove/table`, { waitUntil: "networkidle2" });
  await sleep(5000);
  let sweepOk = true;
  for (const [w, h] of sizes) {
    await page.setViewport({ width: w, height: h });
    await sleep(1200);
    const r = await page.evaluate(() => ({
      noXScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
      hasPanel: /live tables/i.test(document.body.innerText),
    }));
    if (!(r.noXScroll && r.hasPanel)) {
      sweepOk = false;
      await shot(page, `sweep-fail-${w}x${h}`);
      console.log(`sweep FAIL at ${w}x${h}: ${JSON.stringify(r)}`);
    }
  }
  await page.setViewport({ width: 390, height: 844 });
  await sleep(1200);
  await shot(page, "lobby-mobile-staging");
  step("viewport sweep (7 sizes)", sweepOk);
} catch (err) {
  step("walkthrough aborted", false, String(err?.message || err));
} finally {
  fs.writeFileSync(path.join(outDir, "wt-verdict.json"), JSON.stringify(verdict, null, 2));
  await browser.close();
  console.log("PROFILE_DIR=" + profileDir);
}
const failed = verdict.steps.filter((s) => !s.ok);
console.log(`\nVERDICT: ${verdict.steps.length - failed.length}/${verdict.steps.length} pass`);
process.exit(failed.length ? 1 : 0);
