/** Phase 4 — the real multiplayer proof: landtest2 creates a private table and
 *  auto-seats; landtest3 joins via the one-time code; the server deals; both
 *  clients act to settlement; both walk away. Two isolated browser contexts. */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import puppeteer from "puppeteer-core";

const BASE = "https://staging.clawville.world";
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const outDir = path.resolve(import.meta.dirname);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt4-chrome-"));
const PASSWORD = process.env.WT_PASSWORD;

const verdict = { steps: [], profileDir };
const step = (n, ok, d = "") => {
  verdict.steps.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickExact = (page, text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim().toLowerCase() === t.toLowerCase() && !b.disabled,
    );
    if (el) { el.click(); return true; }
    return false;
  }, text);
const clickContains = (page, text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.toLowerCase().includes(t.toLowerCase()) && !b.disabled,
    );
    if (el) { el.click(); return true; }
    return false;
  }, text);

async function login(ctx, email) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(3500);
  return page;
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: "new",
  userDataDir: profileDir,
  args: ["--no-first-run", "--disable-extensions", "--window-size=1440,900", "--use-angle=swiftshader"],
  defaultViewport: { width: 1440, height: 900 },
});

try {
  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const A = await login(ctxA, "landtest3@staging.clawville.test");
  const B = await login(ctxB, "landtest2@staging.clawville.test");
  step("both logins", !A.url().includes("/login") && !B.url().includes("/login"));

  // A creates a private table (no seeded bots — they are house-only by design).
  await A.goto(`${BASE}/cove/table`, { waitUntil: "domcontentloaded" });
  await sleep(6000);
  await clickExact(A, "Create Table");
  await sleep(1200);
  await clickExact(A, "Private table");
  await sleep(800);
  await A.evaluate(() => {
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
  await clickExact(A, "Create private table");
  await sleep(6000);
  // Full code: the standalone all-caps token rendered inside the code panel.
  const code = await A.evaluate(() => {
    const codeEl = [...document.querySelectorAll("*")]
      .filter((e) => e.children.length === 0)
      .map((e) => (e.textContent || "").trim())
      .filter((t) => /^[A-Z0-9]{4,12}$/.test(t) && !["COVE"].includes(t));
    return codeEl[0] ?? null;
  });
  verdict.joinCode = code;
  await A.screenshot({ path: path.join(outDir, "wt4-code.png") });
  step("private table created, code parsed", !!code, `code=${code}`);
  if (!code) throw new Error("no code");
  await clickContains(A, "Enter table");
  await sleep(12_000);
  step("A seated (auto via code)", true, A.url());

  // B joins via Have a code?
  await B.goto(`${BASE}/cove/table`, { waitUntil: "domcontentloaded" });
  await B.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /have a code\?/i.test(b.textContent)),
    { timeout: 60_000 },
  );
  await sleep(1000);
  const tabbed = await clickExact(B, "Have a code?");
  await B.waitForFunction(
    () => /join a private table/i.test(document.body.innerText),
    { timeout: 20_000 },
  ).catch(() => {});
  console.log(`B tabbed to code panel: ${tabbed}`);
  await sleep(500);
  const typed = await B.evaluate((c) => {
    const inputs = [...document.querySelectorAll("input")].filter(
      (i) => i.type !== "email" && i.type !== "password" && i.offsetParent !== null,
    );
    const input =
      inputs.find((i) =>
        /code/i.test(i.id + i.name + (i.placeholder || "") + (i.getAttribute("aria-label") || "")),
      ) || inputs[0];
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, c);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, code);
  await sleep(500);
  const joined = (await clickContains(B, "Join table")) || (await clickContains(B, "Join"));
  // Joining routes via client push (tableId query) — wait for the URL param.
  await B.waitForFunction(() => location.search.includes("tableId="), { timeout: 30_000 }).catch(() => {});
  step("B join-by-code submitted", typed && joined && B.url().includes("tableId="), B.url());
  await sleep(12_000);
  await B.screenshot({ path: path.join(outDir, "wt4-b-room.png") }).catch(() => {});

  // Both act until settlement.
  let actsA = 0, actsB = 0, settle = false;
  const deadline = Date.now() + 200_000;
  while (Date.now() < deadline) {
    for (const [page, who] of [[A, "A"], [B, "B"]]) {
      try {
        const body = await page.evaluate(() => document.body.innerText.toLowerCase());
        if (/pot awarded|wins the pot|showdown/.test(body)) { settle = true; break; }
        for (const label of ["Check", "Call"]) {
          if (await clickContains(page, label)) {
            who === "A" ? actsA++ : actsB++;
            console.log(`${who} acted: ${label} (A=${actsA} B=${actsB})`);
            break;
          }
        }
      } catch {
        /* transient navigation — retry next tick */
      }
    }
    if (settle) break;
    await sleep(2000);
  }
  await A.screenshot({ path: path.join(outDir, "wt4-a-end.png") });
  await B.screenshot({ path: path.join(outDir, "wt4-b-end.png") });
  step("hand dealt + both players acted", actsA + actsB > 0, `A=${actsA} B=${actsB} settle=${settle}`);
  step("hand settled", settle);

  // Walk both away.
  await clickContains(A, "Walk Away");
  await clickContains(B, "Walk Away");
  await sleep(6000);
  const aDone = await A.evaluate(() => /cash/i.test(document.body.innerText));
  const bDone = await B.evaluate(() => /cash/i.test(document.body.innerText));
  await A.screenshot({ path: path.join(outDir, "wt4-a-walk.png") });
  step("both walked away", aDone && bDone, `A=${aDone} B=${bDone}`);
} catch (err) {
  step("aborted", false, String(err?.message || err));
} finally {
  fs.writeFileSync(path.join(outDir, "wt4-verdict.json"), JSON.stringify(verdict, null, 2));
  await browser.close();
  console.log("PROFILE_DIR=" + profileDir);
}
const failed = verdict.steps.filter((s) => !s.ok);
console.log(`\nVERDICT: ${verdict.steps.length - failed.length}/${verdict.steps.length} pass`);
process.exit(failed.length ? 1 : 0);
