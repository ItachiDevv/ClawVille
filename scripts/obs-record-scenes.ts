/**
 * OBS + Puppeteer recorder for ClawVille.
 * Launches Chrome via Puppeteer for automation, configures OBS to capture it.
 *
 * Usage:
 *   bun run scripts/obs-record-scenes.ts              # all 19 scenes
 *   bun run scripts/obs-record-scenes.ts arena-overview  # single scene
 *   bun run scripts/obs-record-scenes.ts status        # OBS status
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
const SESSION_COOKIE = process.env.AUTH_SESSION || "mtgzjbu76bac5ha4a5ntharb2hbvqs5z43wdodls";

await mkdir(RECORDINGS_DIR, { recursive: true });

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

// Update OBS to capture the Puppeteer Chrome window
async function updateOBSWindowCapture() {
  // Wait for the Puppeteer window to appear in OBS
  for (let attempt = 0; attempt < 10; attempt++) {
    const props = await obs.call("GetInputPropertiesListPropertyItems", {
      inputName: "Chrome Game",
      propertyName: "window",
    });

    // Find a Chrome window with ClawVille or localhost:3001 in the title
    const clawWindows = props.propertyItems.filter(
      (p: any) => p.itemValue?.includes("ClawVille") || p.itemValue?.includes("localhost:3001")
    );

    if (clawWindows.length > 0) {
      // Pick the most recent one (last in list, likely the Puppeteer window)
      const target = clawWindows[clawWindows.length - 1];
      await obs.call("SetInputSettings", {
        inputName: "Chrome Game",
        inputSettings: {
          window: target.itemValue,
          capture_cursor: false,
          method: 2,
        },
      });
      console.log(`  OBS capturing: ${target.itemValue.split(":")[0]}`);
      return true;
    }

    await sleep(1000);
  }
  console.error("  Could not find ClawVille window in OBS!");
  return false;
}

async function moveRecording(obsPath: string, name: string): Promise<string> {
  const ext = obsPath.split(".").pop() ?? "mp4";
  const finalPath = join(RECORDINGS_DIR, `${name}.${ext}`);
  await sleep(1500);
  try {
    await rename(obsPath, finalPath);
  } catch {
    try { await copyFile(obsPath, finalPath); } catch (e: any) {
      console.error(`  Move failed: ${e.message}`);
      return obsPath;
    }
  }
  const s = await stat(finalPath);
  console.log(`  Done: ${name}.${ext} (${(s.size / 1024 / 1024).toFixed(1)} MB)`);
  return finalPath;
}

// --- Scene definitions ---

interface Scene {
  id: string;
  filename: string;
  url: string;
  durationSec: number;
  setup: (page: any) => Promise<void>;
  actions: (page: any) => Promise<void>;
}

const scenes: Scene[] = [
  // === GAME WORLD ===
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
      await sleep(3000); await clickCanvas(page);
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
  // === ARENA ===
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
  // === EXTRAS ===
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
      await sleep(3000); await clickCanvas(page);
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

// --- Recording ---

async function recordScene(scene: Scene) {
  console.log(`\n=== ${scene.id} (${scene.durationSec}s) → ${scene.filename}.mp4 ===`);

  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: false,
    defaultViewport: { width: 1920, height: 1080 },
    args: [
      "--window-size=1920,1080",
      "--window-position=0,0",
      "--disable-infobars",
      "--disable-extensions",
      "--no-first-run",
    ],
  });

  const page = await browser.newPage();
  await page.setCookie({
    name: "auth_session",
    value: SESSION_COOKIE,
    domain: "localhost",
    path: "/",
  });
  await page.goto(scene.url, { waitUntil: "load", timeout: 60000 });
  console.log(`  Loaded: ${scene.url}`);

  // Wait for window to appear, then update OBS capture
  await sleep(2000);
  await updateOBSWindowCapture();

  // Setup
  await scene.setup(page);

  // Start recording
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

  // Stop
  const result = await obs.call("StopRecord");
  await moveRecording(result.outputPath, scene.filename);

  await browser.close();
  await sleep(2000);
}

// --- Main ---

async function main() {
  const target = process.argv[2];

  if (target === "status") {
    await obs.connect(OBS_HOST);
    const s = await obs.call("GetRecordStatus");
    const v = await obs.call("GetVideoSettings");
    console.log(`Resolution: ${v.baseWidth}x${v.baseHeight}`);
    console.log(`Recording: ${s.outputActive ? "ACTIVE" : "stopped"}`);
    await obs.disconnect();
    return;
  }

  await obs.connect(OBS_HOST);
  console.log("OBS connected");

  await obs.call("SetProfileParameter", {
    parameterCategory: "SimpleOutput",
    parameterName: "FilePath",
    parameterValue: RECORDINGS_DIR,
  });

  // Ensure Chrome Game source is enabled, others disabled
  await obs.call("SetSceneItemEnabled", { sceneName: "Scene", sceneItemId: 1, sceneItemEnabled: false });
  await obs.call("SetSceneItemEnabled", { sceneName: "Scene", sceneItemId: 2, sceneItemEnabled: false });
  await obs.call("SetSceneItemEnabled", { sceneName: "Scene", sceneItemId: 3, sceneItemEnabled: false });
  await obs.call("SetSceneItemEnabled", { sceneName: "Scene", sceneItemId: 4, sceneItemEnabled: true });

  const scenesToRecord = target
    ? scenes.filter((s) => s.id === target)
    : scenes;

  if (scenesToRecord.length === 0) {
    console.log(`Scene "${target}" not found. Available:\n${scenes.map((s) => `  ${s.id}`).join("\n")}`);
    await obs.disconnect();
    process.exit(1);
  }

  console.log(`Recording ${scenesToRecord.length} scenes\n`);

  for (let i = 0; i < scenesToRecord.length; i++) {
    console.log(`[${i + 1}/${scenesToRecord.length}]`);
    try {
      await recordScene(scenesToRecord[i]);
    } catch (err) {
      console.error(`  FAILED: ${scenesToRecord[i].id} — ${err}`);
      try { await obs.call("StopRecord"); } catch {}
      await sleep(2000);
    }
  }

  console.log("\n=== All recordings complete! ===");
  console.log(`Output: ${RECORDINGS_DIR}`);
  await obs.disconnect();
}

main().catch(console.error);
