#!/usr/bin/env node
// Read-only logger for the Trading Floor arena during a film take (docs/video-production.md section 3).
// Polls the PUBLIC arena API and writes one JSON line per new fact to <out>/arena.jsonl, each with the
// wall clock in epoch ms, so the footage map can place every event on the recording's timeline
// (footage second = event ms - recording start ms from rig.log). It never writes to the API.
//
//   node scripts/film/arena-probe.mjs --api https://api.clawville.world --out <take dir> \
//     [--agent <film agent id>] [--minutes 120] [--once]
//
// Place each event on the footage timeline by the event's own `at` (server time), never by the probe's `ms`:
// agents are read in turn, so a poll can arrive up to (number of agents x 2 s) after the event.
//
// Stdout prints one short line per change (entries, exits, param changes, reports, board moves), so a
// Monitor can follow a take. Spec for the routes: docs/trading-floor-arena.md section 5.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const API = (opt("api", "https://api.clawville.world") || "").replace(/\/+$/, "");
const OUT = opt("out");
const FILM_AGENT = opt("agent");
const MINUTES = Number(opt("minutes", "120"));
const ONCE = flag("once");
if (!OUT) {
  console.error("usage: node arena-probe.mjs --api <base> --out <dir> [--agent <id>] [--minutes 120] [--once]");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "arena.jsonl");

const write = (kind, data) => appendFileSync(LOG, `${JSON.stringify({ ms: Date.now(), at: new Date().toISOString(), kind, ...data })}\n`);
const say = (line) => console.log(`${new Date().toISOString().slice(11, 19)}Z ${line}`);

async function get(path) {
  const url = `${API}${path}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { error: String(err && err.message ? err.message : err) } };
  }
}

// ---- one-time reads: which build is live, which agents exist ----
const health = await get("/health");
write("health", { status: health.status, commit: health.body && health.body.commit });
say(`health ${health.status} commit ${health.body && health.body.commit}`);

const templates = await get("/api/floor/arena/templates");
write("templates", { status: templates.status, body: templates.body });
const houseIds = [];
if (templates.status === 200 && templates.body) {
  // GET /templates returns { templates: [...{ houseAgentId }], houseAgents: [...{ id, name, stats }] }
  for (const h of templates.body.houseAgents || []) if (h.id && !houseIds.includes(h.id)) houseIds.push(h.id);
  for (const t of templates.body.templates || []) if (t.houseAgentId && !houseIds.includes(t.houseAgentId)) houseIds.push(t.houseAgentId);
  say(`templates 200: ${(templates.body.templates || []).length} templates, house agents ${houseIds.join(", ") || "none"}`);
} else {
  say(`templates ${templates.status}: the arena API is not live at ${API}`);
}
const tracked = FILM_AGENT ? [...houseIds, FILM_AGENT] : houseIds;

// ---- polling state ----
// Rate budget: the arena's public GETs allow 60 requests per minute per IP PER ROUTE, and the filmed browser
// (same IP) polls the events route too (its desk panel, every 5 s). So the probe asks for ONE agent's events
// per 2 s tick, in turn (about 30 per minute however many agents), the board every 30 s, the contest every
// 60 s. The spec's /tape route may not exist; the first 404 switches it off.
const lastEventId = new Map(); // agentId -> highest event id seen
const seenTape = new Set();
let lastBoard = "";
let lastContest = "";

let cursor = 0;
async function pollEvents() {
  if (tracked.length === 0) return;
  const id = tracked[cursor % tracked.length];
  cursor += 1;
  {
    const after = lastEventId.get(id);
    const q = after ? `?after=${encodeURIComponent(after)}&limit=100` : "?limit=100";
    const r = await get(`/api/floor/arena/agents/${encodeURIComponent(id)}/events${q}`);
    if (r.status !== 200) { write("events_error", { agentId: id, status: r.status, body: r.body }); return; }
    const events = Array.isArray(r.body) ? r.body : r.body.events || [];
    const ordered = [...events].sort((a, b) => Number(a.id) - Number(b.id));
    for (const e of ordered) {
      if (after && Number(e.id) <= Number(after)) continue;
      write("event", { agentId: id, event: e });
      if (["entry", "exit", "param_change", "report", "status"].includes(e.type)) say(`${id} ${e.type}: ${e.summary || ""}`);
      if (!lastEventId.has(id) || Number(e.id) > Number(lastEventId.get(id))) lastEventId.set(id, e.id);
    }
  }
}

let tapeOn = true;
async function pollTape() {
  if (!tapeOn) return;
  const r = await get("/api/floor/arena/tape?limit=24");
  if (r.status === 404) { tapeOn = false; write("tape_off", { status: 404 }); return; }
  if (r.status !== 200) { write("tape_error", { status: r.status }); return; }
  const rows = Array.isArray(r.body) ? r.body : r.body.tape || r.body.rows || [];
  for (const row of rows) {
    const key = String(row.id);
    if (seenTape.has(key)) continue;
    seenTape.add(key);
    write("tape", { row });
    say(`tape ${row.agentName || row.agentId} ${row.type || ""} ${row.symbol || ""} ${row.pnlUsd != null ? `pnl ${row.pnlUsd}` : ""}`.trim());
  }
}

async function pollBoard() {
  const r = await get("/api/floor/arena/leaderboard?window=contest");
  if (r.status !== 200) { write("board_error", { status: r.status }); return; }
  const rows = Array.isArray(r.body) ? r.body : r.body.rows || r.body.leaderboard || [];
  const sig = JSON.stringify(rows.map((x) => [x.rank, x.agentId, x.realisedUsd, x.trades]));
  if (sig !== lastBoard) {
    lastBoard = sig;
    write("board", { rows });
    say(`board: ${rows.slice(0, 6).map((x) => `${x.rank}.${x.name}=${x.realisedUsd}`).join("  ")}`);
  }
}

async function pollContest() {
  const r = await get("/api/floor/arena/contest");
  if (r.status !== 200) { write("contest_error", { status: r.status }); return; }
  const sig = JSON.stringify(r.body);
  if (sig !== lastContest) { lastContest = sig; write("contest", { body: r.body }); say("contest changed"); }
}

if (templates.status !== 200) {
  write("stop", { reason: "arena API not live" });
  process.exit(ONCE ? 0 : 1);
}

const deadline = Date.now() + MINUTES * 60_000;
let tick = 0;
do {
  if (ONCE) { for (let i = 0; i < tracked.length; i += 1) await pollEvents(); } else await pollEvents();
  if (tick % 5 === 0) await pollTape();
  if (tick % 15 === 0) await pollBoard();
  if (tick % 30 === 0) await pollContest();
  tick += 1;
  if (ONCE) break;
  await new Promise((r) => setTimeout(r, 2000));
} while (Date.now() < deadline);
write("stop", { reason: ONCE ? "once" : "deadline" });
