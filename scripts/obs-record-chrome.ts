/**
 * OBS recording + Chrome CDP automation for ClawVille.
 * Connects to EXISTING Chrome instance via CDP (no new window).
 * OBS captures the same Chrome window.
 *
 * Usage:
 *   bun run scripts/obs-record-chrome.ts              # all scenes
 *   bun run scripts/obs-record-chrome.ts arena-overview  # single scene
 */

import OBSWebSocket from "obs-websocket-js";
import puppeteer from "puppeteer-core";
import { rename, copyFile, stat, mkdir } from "fs/promises";
import { join } from "path";

const OBS_HOST = "ws://localhost:4455";
const RECORDINGS_DIR = join(
  "C:", "Users", "newma", "Documents", "Crypto", "ClawVille",
  "apps", "promo-videos", "public", "recordings"
);
await mkdir(RECORDINGS_DIR, { recursive: true });

// Chrome CDP remote debugging - connect to existing Chrome
const CDP_URL = "http://localhost:9222";

const obs = new OBSWebSocket();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function holdKey(page: any, key: string, ms: number) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
  await sleep(50);
}

async function clickByText(page: any, text: string): Promise<boolean> {
  try {
    const [el] = await page.$$(
      `xpath/.//button[contains(., "${text}")] | .//a[contains(., "${text}")] | .//*[contains(text(), "${text}")]`
    );
    if (el) { await el.click(); return true; }
  } catch {}
  return false;
}

async function clickCanvas(page: any) {
  const canvas = await page.$("canvas");
  if (canvas) {
    const box = await canvas.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

interface Scene {
  id: string;
  filename: string;
  url: string;
  durationSec: number;
  setup: (page: any) => Promise<void>;
  actions: (page: any) => Promise<void>;
}

const gameScenes: Scene[] = [
  {
    id: "world-exploration-npcs",
    filename: "game-world-exploration-npcs",
    url: "http://localhost:3001/game",
    durationSec: 25,
    setup: async (page) => { await sleep(3000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "d", 2500);
      await sleep(1500);
      await holdKey(page, "s", 2000);
      await sleep(1000);
      await holdKey(page, "a", 3000);
      await sleep(1500);
      await holdKey(page, "w", 2000);
      await sleep(1000);
      await holdKey(page, "d", 2000);
      await sleep(2000);
    },
  },
  {
    id: "explore-buildings",
    filename: "game-explore-buildings",
    url: "http://localhost:3001/game",
    durationSec: 25,
    setup: async (page) => { await sleep(3000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "d", 1500);
      await holdKey(page, "w", 2000);
      await page.keyboard.press("e");
      await sleep(3000);
      await page.keyboard.press("Escape");
      await holdKey(page, "d", 2000);
      await holdKey(page, "s", 1500);
      await page.keyboard.press("e");
      await sleep(2500);
      await page.keyboard.press("Escape");
      await sleep(1000);
    },
  },
  {
    id: "building-chat-learn",
    filename: "game-building-chat-learn",
    url: "http://localhost:3001/game",
    durationSec: 22,
    setup: async (page) => {
      await sleep(3000);
      await clickCanvas(page);
      await holdKey(page, "w", 2000);
      await holdKey(page, "d", 1000);
    },
    actions: async (page) => {
      await page.keyboard.press("e");
      await sleep(2000);
      try {
        const input = await page.$('input[type="text"], textarea');
        if (input) {
          await input.click();
          await input.type("Tell me about Solana", { delay: 80 });
          await page.keyboard.press("Enter");
        }
      } catch {}
      await sleep(5000);
      await page.keyboard.press("Escape");
      await sleep(1000);
    },
  },
  {
    id: "avatar-chat-shop",
    filename: "game-avatar-chat-shop",
    url: "http://localhost:3001/game",
    durationSec: 22,
    setup: async (page) => {
      await sleep(3000);
      await clickCanvas(page);
      await holdKey(page, "d", 1500);
      await holdKey(page, "w", 2000);
    },
    actions: async (page) => {
      await page.keyboard.press("e");
      await sleep(1500);
      try { await clickByText(page, "Shop"); } catch {}
      await sleep(4000);
      await page.keyboard.press("Escape");
      await sleep(1500);
    },
  },
  {
    id: "openclaw-connect",
    filename: "game-openclaw-connect",
    url: "http://localhost:3001/game",
    durationSec: 22,
    setup: async (page) => { await sleep(3000); },
    actions: async (page) => {
      try { await clickByText(page, "OpenClaw"); } catch {}
      await sleep(5000);
      await page.keyboard.press("Escape");
      await sleep(2000);
      await clickCanvas(page);
      await holdKey(page, "d", 1500);
      await sleep(2000);
    },
  },
  {
    id: "openclaw-skills",
    filename: "game-openclaw-skills",
    url: "http://localhost:3001/game",
    durationSec: 22,
    setup: async (page) => { await sleep(3000); await clickCanvas(page); },
    actions: async (page) => {
      try {
        const gear = await page.$('[aria-label="Settings"], [aria-label="Menu"]');
        if (gear) await gear.click();
        else await clickByText(page, "Menu");
      } catch {}
      await sleep(3000);
      await page.keyboard.press("Escape");
      await sleep(1000);
      try { await clickByText(page, "Inventory"); } catch {}
      await sleep(3000);
      await page.keyboard.press("Escape");
      await sleep(1500);
    },
  },
  {
    id: "menu-skills-inventory",
    filename: "game-menu-skills-inventory",
    url: "http://localhost:3001/game",
    durationSec: 20,
    setup: async (page) => { await sleep(3000); },
    actions: async (page) => {
      try {
        const gear = await page.$('[aria-label="Settings"]');
        if (gear) await gear.click();
        else await clickByText(page, "Menu");
      } catch {}
      await sleep(3000);
      await page.keyboard.press("Escape");
      await sleep(1000);
      try { await clickByText(page, "Inventory"); } catch {}
      await sleep(3000);
      await page.keyboard.press("Escape");
    },
  },
];

const arenaScenes: Scene[] = [
  {
    id: "arena-overview",
    filename: "arena-overview-pan",
    url: "http://localhost:3001/arena",
    durationSec: 30,
    setup: async (page) => { await sleep(5000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "d", 2500);
      await holdKey(page, "w", 2000);
      await sleep(2000);
      await holdKey(page, "a", 3000);
      await holdKey(page, "s", 1500);
      await sleep(2000);
      await holdKey(page, "d", 1500);
      await sleep(2000);
    },
  },
  {
    id: "arena-combat",
    filename: "arena-combat-closeup",
    url: "http://localhost:3001/arena",
    durationSec: 25,
    setup: async (page) => { await sleep(5000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "d", 1200);
      await sleep(4000);
      await holdKey(page, "w", 1000);
      await sleep(4000);
      await holdKey(page, "a", 800);
      await sleep(3000);
    },
  },
  {
    id: "arena-kills",
    filename: "arena-kills-respawns",
    url: "http://localhost:3001/arena",
    durationSec: 22,
    setup: async (page) => { await sleep(5000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "a", 1500);
      await sleep(3000);
      await holdKey(page, "d", 2000);
      await sleep(3000);
      await holdKey(page, "w", 1000);
      await sleep(2000);
    },
  },
  {
    id: "arena-royale",
    filename: "arena-battle-royale",
    url: "http://localhost:3001/arena",
    durationSec: 30,
    setup: async (page) => { await sleep(5000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "d", 1500);
      await holdKey(page, "w", 1200);
      await sleep(3000);
      await holdKey(page, "a", 2000);
      await holdKey(page, "s", 1500);
      await sleep(3000);
      await holdKey(page, "d", 1000);
      await sleep(2000);
    },
  },
  {
    id: "arena-connect",
    filename: "arena-connect-settings",
    url: "http://localhost:3001/arena",
    durationSec: 18,
    setup: async (page) => { await sleep(4000); },
    actions: async (page) => {
      try { await clickByText(page, "Connect"); } catch {}
      await sleep(3000);
      await page.keyboard.press("Escape");
      await sleep(1000);
      try {
        const gear = await page.$('[aria-label="Settings"]');
        if (gear) await gear.click();
      } catch {}
      await sleep(3000);
      await page.keyboard.press("Escape");
    },
  },
];

const extraScenes: Scene[] = [
  {
    id: "world-exploration",
    filename: "world-exploration",
    url: "http://localhost:3001/game",
    durationSec: 25,
    setup: async (page) => { await sleep(3000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "w", 2000);
      await holdKey(page, "d", 2500);
      await sleep(1500);
      await holdKey(page, "s", 2000);
      await holdKey(page, "a", 1500);
      await sleep(2000);
    },
  },
  {
    id: "building-chat",
    filename: "building-chat",
    url: "http://localhost:3001/game",
    durationSec: 22,
    setup: async (page) => { await sleep(3000); await clickCanvas(page); await holdKey(page, "w", 1500); },
    actions: async (page) => {
      await page.keyboard.press("e");
      await sleep(5000);
      await page.keyboard.press("Escape");
      await holdKey(page, "d", 1500);
      await page.keyboard.press("e");
      await sleep(4000);
      await page.keyboard.press("Escape");
    },
  },
  {
    id: "openclaw-connect-extra",
    filename: "openclaw-connect",
    url: "http://localhost:3001/game",
    durationSec: 22,
    setup: async (page) => { await sleep(3000); },
    actions: async (page) => {
      try { await clickByText(page, "OpenClaw"); } catch {}
      await sleep(6000);
      await page.keyboard.press("Escape");
      await sleep(2000);
    },
  },
  {
    id: "daily-rewards",
    filename: "daily-rewards",
    url: "http://localhost:3001/game",
    durationSec: 18,
    setup: async (page) => { await sleep(3000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "w", 1500);
      await holdKey(page, "d", 1500);
      await sleep(2000);
      await holdKey(page, "s", 1500);
      await holdKey(page, "a", 1000);
      await sleep(2000);
    },
  },
  {
    id: "shop-books",
    filename: "shop-books",
    url: "http://localhost:3001/game",
    durationSec: 18,
    setup: async (page) => {
      await sleep(3000);
      await clickCanvas(page);
      await holdKey(page, "w", 2000);
      await holdKey(page, "d", 1000);
    },
    actions: async (page) => {
      await page.keyboard.press("e");
      await sleep(2000);
      try { await clickByText(page, "Shop"); } catch {}
      await sleep(4000);
      await page.keyboard.press("Escape");
    },
  },
  {
    id: "avatar-stats",
    filename: "avatar-stats",
    url: "http://localhost:3001/game",
    durationSec: 18,
    setup: async (page) => { await sleep(3000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "d", 1000);
      await sleep(2000);
      await holdKey(page, "w", 1200);
      await sleep(2000);
      await holdKey(page, "a", 1000);
      await sleep(2000);
    },
  },
  {
    id: "npc-activity",
    filename: "npc-activity",
    url: "http://localhost:3001/game",
    durationSec: 20,
    setup: async (page) => { await sleep(3000); await clickCanvas(page); },
    actions: async (page) => {
      await holdKey(page, "s", 1500);
      await holdKey(page, "d", 2000);
      await sleep(3000);
      await holdKey(page, "a", 1500);
      await sleep(2000);
    },
  },
];

const allScenes = [...gameScenes, ...arenaScenes, ...extraScenes];

async function moveRecording(obsPath: string, name: string): Promise<string> {
  const ext = obsPath.split(".").pop() ?? "mp4";
  const finalPath = join(RECORDINGS_DIR, `${name}.${ext}`);
  await sleep(1500);
  try { await rename(obsPath, finalPath); }
  catch { try { await copyFile(obsPath, finalPath); } catch (e: any) {
    console.error(`  Could not move: ${e.message}`);
    return obsPath;
  }}
  const s = await stat(finalPath);
  console.log(`  Saved: ${name}.${ext} (${(s.size / 1024 / 1024).toFixed(1)} MB)`);
  return finalPath;
}

async function recordScene(scene: Scene, browser: any) {
  console.log(`\n=== ${scene.id} (${scene.durationSec}s) → ${scene.filename}.mp4 ===`);

  // Get existing pages
  const pages = await browser.pages();
  let page = pages.find((p: any) => {
    try { return p.url().includes("localhost:3001"); } catch { return false; }
  });

  if (!page) {
    page = pages[0];
  }

  // Navigate to scene URL
  const currentUrl = page.url();
  const needsNav = !currentUrl.includes(new URL(scene.url).pathname);
  if (needsNav) {
    await page.goto(scene.url, { waitUntil: "load", timeout: 30000 });
    console.log(`  Navigated to ${scene.url}`);
  }

  // Setup (before recording)
  await scene.setup(page);

  // Start OBS
  await sleep(1000);
  await obs.call("StartRecord");
  console.log(`  Recording...`);
  await sleep(1000);

  // Actions
  try {
    await scene.actions(page);
  } catch (err) {
    console.error(`  Action error: ${err}`);
  }

  // Buffer
  await sleep(2000);

  // Stop OBS
  const result = await obs.call("StopRecord");
  const finalPath = await moveRecording(result.outputPath, scene.filename);

  await sleep(2000);
}

// --- Main ---

async function main() {
  const target = process.argv[2];

  // Connect OBS
  await obs.connect(OBS_HOST);
  console.log("OBS connected");
  await obs.call("SetProfileParameter", {
    parameterCategory: "SimpleOutput",
    parameterName: "FilePath",
    parameterValue: RECORDINGS_DIR,
  });

  // Connect to existing Chrome via CDP
  console.log("Connecting to Chrome via CDP...");
  let browser: any;
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL });
    console.log("Connected to existing Chrome");
  } catch (err: any) {
    console.error(`Cannot connect to Chrome CDP at ${CDP_URL}`);
    console.error("Start Chrome with: --remote-debugging-port=9222");
    console.error(`Error: ${err.message}`);
    await obs.disconnect();
    process.exit(1);
  }

  const scenesToRecord = target
    ? allScenes.filter((s) => s.id === target)
    : allScenes;

  if (scenesToRecord.length === 0) {
    console.log(`Scene "${target}" not found. Available:\n${allScenes.map((s) => `  ${s.id}`).join("\n")}`);
    await obs.disconnect();
    process.exit(1);
  }

  console.log(`Recording ${scenesToRecord.length} scenes → ${RECORDINGS_DIR}\n`);

  for (let i = 0; i < scenesToRecord.length; i++) {
    console.log(`[${i + 1}/${scenesToRecord.length}]`);
    try {
      await recordScene(scenesToRecord[i], browser);
    } catch (err) {
      console.error(`  FAILED: ${scenesToRecord[i].id} — ${err}`);
      try { await obs.call("StopRecord"); } catch {}
      await sleep(2000);
    }
  }

  console.log("\n=== All recordings complete! ===");
  console.log(`Output: ${RECORDINGS_DIR}`);
  browser.disconnect();
  await obs.disconnect();
}

main().catch(console.error);
