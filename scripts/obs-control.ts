/**
 * Simple OBS recording control via WebSocket.
 * Usage:
 *   bun run scripts/obs-control.ts start          # start recording
 *   bun run scripts/obs-control.ts stop            # stop recording
 *   bun run scripts/obs-control.ts record <name> <seconds>  # timed recording
 *   bun run scripts/obs-control.ts status          # check status
 *   bun run scripts/obs-control.ts rename <name>   # rename last recording
 */

import OBSWebSocket from "obs-websocket-js";
import { rename, copyFile, readdir, stat } from "fs/promises";
import { join } from "path";

const OBS_HOST = process.env.OBS_WS_HOST ?? "ws://localhost:4455";
const OBS_PASSWORD = process.env.OBS_WS_PASSWORD ?? undefined;
const RECORDINGS_DIR = join(
  "C:",
  "Users",
  "newma",
  "Documents",
  "Crypto",
  "ClawVille",
  "apps",
  "promo-videos",
  "public",
  "recordings"
);

const obs = new OBSWebSocket();

async function connect() {
  const info = await obs.connect(OBS_HOST, OBS_PASSWORD);
  console.log(`Connected to OBS v${info.obsStudioVersion}`);
}

async function moveToRecordings(obsPath: string, name: string): Promise<string> {
  const ext = obsPath.split(".").pop() ?? "mp4";
  const finalPath = join(RECORDINGS_DIR, `${name}.${ext}`);
  await new Promise((r) => setTimeout(r, 1000));
  try {
    await rename(obsPath, finalPath);
  } catch {
    await copyFile(obsPath, finalPath);
  }
  const s = await stat(finalPath);
  console.log(`Saved: ${finalPath} (${(s.size / 1024 / 1024).toFixed(1)} MB)`);
  return finalPath;
}

const cmd = process.argv[2];

await connect();

// Set output path
await obs.call("SetProfileParameter", {
  parameterCategory: "SimpleOutput",
  parameterName: "FilePath",
  parameterValue: RECORDINGS_DIR,
});

if (cmd === "start") {
  await obs.call("StartRecord");
  console.log("Recording started");
} else if (cmd === "stop") {
  const result = await obs.call("StopRecord");
  console.log(`Recording stopped: ${result.outputPath}`);
  const name = process.argv[3];
  if (name) {
    await moveToRecordings(result.outputPath, name);
  }
} else if (cmd === "record") {
  const name = process.argv[3] ?? "test";
  const seconds = parseInt(process.argv[4] ?? "10", 10);
  console.log(`Recording "${name}" for ${seconds}s...`);
  await obs.call("StartRecord");
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write(`\r  ${i + 1}/${seconds}s`);
  }
  console.log();
  const result = await obs.call("StopRecord");
  await moveToRecordings(result.outputPath, name);
} else if (cmd === "rename") {
  const name = process.argv[3];
  if (!name) {
    console.error("Usage: obs-control.ts rename <name>");
    process.exit(1);
  }
  // Find most recent file in recordings dir
  const files = await readdir(RECORDINGS_DIR);
  const mp4s = files.filter((f) => f.endsWith(".mp4") || f.endsWith(".mkv"));
  const stats = await Promise.all(
    mp4s.map(async (f) => ({
      name: f,
      time: (await stat(join(RECORDINGS_DIR, f))).mtimeMs,
    }))
  );
  stats.sort((a, b) => b.time - a.time);
  if (stats.length > 0) {
    const latest = stats[0].name;
    const ext = latest.split(".").pop() ?? "mp4";
    const src = join(RECORDINGS_DIR, latest);
    const dst = join(RECORDINGS_DIR, `${name}.${ext}`);
    await rename(src, dst);
    console.log(`Renamed ${latest} -> ${name}.${ext}`);
  }
} else {
  // status
  const s = await obs.call("GetRecordStatus");
  const v = await obs.call("GetVideoSettings");
  const scenes = await obs.call("GetSceneList");
  console.log(`Scene: ${scenes.currentProgramSceneName}`);
  console.log(`Resolution: ${v.baseWidth}x${v.baseHeight}`);
  console.log(`Recording: ${s.outputActive ? "ACTIVE " + s.outputTimecode : "stopped"}`);
  console.log(`Output: ${RECORDINGS_DIR}`);
}

await obs.disconnect();
