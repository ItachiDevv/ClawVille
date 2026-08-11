/** Phase 3: private table WITH seeded bots → live dealt hand → actions → settle → walk away. */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import puppeteer from "puppeteer-core";

const BASE = "https://staging.clawville.world";
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const outDir = path.resolve(import.meta.dirname);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt3-chrome-"));
const EMAIL = process.env.WT_EMAIL;
const PASSWORD = process.env.WT_PASSWORD;

const verdict = { steps: [], profileDir };
const step = (n, ok, d = "") => {
  verdict.steps.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (p, n) => p.screenshot({ path: path.join(outDir, `wt3-${n}.png`) });
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

  // Seeded agents → 2, with verification of the displayed value.
  let seededShown = "?";
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => {
      const leaf = [...document.querySelectorAll("*")].filter(
        (e) => e.children.length === 0 && /seeded agents/i.test(e.textContent || ""),
      );
      for (const h of leaf) {
        let node = h;
        for (let up = 0; up < 6 && node; up++) {
          const plus = [...node.querySelectorAll("button")].find(
            (b) => b.textContent.trim() === "+" && !b.disabled,
          );
          if (plus) { plus.click(); return; }
          node = node.parentElement;
        }
      }
    });
    await sleep(400);
  }
  seededShown = await page.evaluate(() => {
    const leaf = [...document.querySelectorAll("*")].filter(
      (e) => e.children.length === 0 && /seeded agents/i.test(e.textContent || ""),
    );
    for (const h of leaf) {
      let node = h;
      for (let up = 0; up < 6 && node; up++) {
        const val = [...node.querySelectorAll("input, span, div")].find((e) =>
          /^\d+$/.test((e.value ?? e.textContent ?? "").trim()),
        );
        if (val) return (val.value ?? val.textContent).trim();
        node = node.parentElement;
      }
    }
    return "?";
  });
  await shot(page, "create-filled");
  step("seeded agents set to 2", seededShown === "2", `shown=${seededShown}`);

  const submitted = await clickExact(page, "Create private table");
  step("create submitted", submitted);
  await sleep(6000);
  const code = await page.evaluate(() => {
    const m = document.body.innerText.match(/\b[A-Z0-9]{4,12}\b(?=[\s\S]{0,400}Copy)/);
    return m ? m[0] : null;
  });
  verdict.joinCode = code;
  await shot(page, "code");
  step("join code shown", !!code, `code=${code}`);

  const entered = (await clickContains(page, "Enter table")) || (await clickContains(page, "Enter"));
  step("enter table (auto-seats via code)", entered);
  await sleep(15_000);
  await shot(page, "room-initial");

  // With 2 seeded bots + me the table should deal. Play to settlement.
  let acted = 0;
  let sawSettle = false;
  let sawSeatedCopy = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const body = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (body.includes("you are seated")) sawSeatedCopy = true;
    if (/pot awarded|wins the pot|showdown/.test(body)) {
      sawSettle = true;
      await shot(page, "settled");
      break;
    }
    for (const label of ["Check", "Call"]) {
      if (await clickContains(page, label)) {
        acted++;
        console.log(`action #${acted}: ${label}`);
        if (acted <= 6) await shot(page, `act-${acted}`);
        break;
      }
    }
    await sleep(2200);
  }
  await shot(page, "hand-end");
  step("hand dealt vs seeded bots", acted > 0 || sawSettle, `${acted} actions, settle=${sawSettle}, seatedCopy=${sawSeatedCopy}`);

  const walked = await clickContains(page, "Walk Away");
  await sleep(4000);
  const cashCopy = (await hasText(page, "cashing out")) || (await hasText(page, "cashed out")) || (await hasText(page, "returned to your avatar"));
  await shot(page, "walkaway");
  step("walk away + cash-out", walked && cashCopy, `copy=${cashCopy}`);
} catch (err) {
  step("aborted", false, String(err?.message || err));
} finally {
  fs.writeFileSync(path.join(outDir, "wt3-verdict.json"), JSON.stringify(verdict, null, 2));
  await browser.close();
  console.log("PROFILE_DIR=" + profileDir);
}
const failed = verdict.steps.filter((s) => !s.ok);
console.log(`\nVERDICT: ${verdict.steps.length - failed.length}/${verdict.steps.length} pass`);
process.exit(failed.length ? 1 : 0);
