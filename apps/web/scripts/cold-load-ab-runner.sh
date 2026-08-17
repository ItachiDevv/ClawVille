#!/bin/bash
# cold-load-ab-runner.sh — hardened cold-load probe runner (committed rung-4,
# from the rung-3 scratchpad ab-runner-final.sh; the rig rules are hard-won —
# see docs/perf-cold-load-rung4-handoff.md §3 and memory
# feedback_windows_pid_kills_and_batch_health).
#
# Modes:
#   cold-load-ab-runner.sh pairs <backend: webgpu|webgl2> [npairs=12]
#     12 counterbalanced AB/BA pairs. Baseline (A) on :3011 (cv-perf-baseline),
#     candidate (B) on :3010 (cv-covefreeze). Writes a manifest for
#     cold-load-paired-gate.mjs.
#   cold-load-ab-runner.sh solo <arm: A|B> <backend> [nruns=3]
#     Single-arm batch (e.g. slice-A instrumentation baselines).
#
# Output dir: $COLD_LOAD_OUT if set, else ./cold-load-runs/<mode>-<backend>-<epoch>
# Rig rules encoded here:
#  - fresh profile per run; anti-occlusion flags (occluded windows park the boot)
#  - NEVER kill by stored PID (Windows recycles fast — a stale-PID taskkill once
#    killed the :3010 server mid-batch); kill chrome by profile BASENAME match
#  - free_probe_port before launch; ensure_server health check per run
#  - no builds/tests while a batch is running (contention corrupts runs)
set -u
MODE="${1:-pairs}"
CANDIDATE_DIR="C:/Users/itachi/Documents/Crypto/cv-covefreeze"
BASELINE_DIR="C:/Users/itachi/Documents/Crypto/cv-perf-baseline"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PORT_BASE="${COLD_LOAD_PORT_BASE:-9361}"

if [ "$MODE" = "solo" ]; then
  ARM="${2:?solo mode needs arm A|B}"
  BACKEND="${3:-webgpu}"
  COUNT="${4:-3}"
else
  BACKEND="${2:-webgpu}"
  COUNT="${3:-12}"
fi
OUT="${COLD_LOAD_OUT:-$CANDIDATE_DIR/cold-load-runs/$MODE-$BACKEND-$(date +%s)}"
mkdir -p "$OUT"
QS=""
[ "$BACKEND" = "webgl2" ] && QS="?webgl=1"
# Batch-unique profile basename component: kill_probe_chrome matches by profile
# BASENAME — two concurrent/successive batches sharing "profile-1-B" would kill
# each other's Chromes (Codex R19 finding 6).
BATCH_ID="$(date +%s)-$$"
# Chrome profiles MUST live on a REAL filesystem path, never under the Windows
# Temp tree (rung-4 slice-B discovery, 2026-08-11): in Temp-dir profiles
# Chrome's Cache Storage backend fails (`caches.open` → "UnknownError:
# Unexpected internal error"), which kills every service-worker install
# (installing → redundant) — so all prior probe runs measured a SW-LESS page
# and were structurally blind to SW install/cache effects.
PROFILE_ROOT="${COLD_LOAD_PROFILE_ROOT:-$HOME/.cold-load-probe-profiles}"
mkdir -p "$PROFILE_ROOT"
# Any failed run flips this; the script exits nonzero so a caller can never
# mistake AB_RUNNER_DONE-with-failures for clean evidence.
FAILED_RUNS=0

kill_probe_chrome() { # $1 = profile dir (unique per run) - NEVER kill by raw PID
  local base=$(basename "$1")
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*${base}*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
}

free_probe_port() { # $1 = cdp port - kill any leftover CHROME listening there
  powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { \$p = Get-Process -Id \$_ -ErrorAction SilentlyContinue; if (\$p -and \$p.ProcessName -eq 'chrome') { Stop-Process -Id \$p.Id -Force -ErrorAction SilentlyContinue } }" >/dev/null 2>&1
}

ensure_server() { # $1=port $2=worktree dir — returns nonzero if still dead
  local code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:$1/game" 2>/dev/null)
  if [ "$code" != "200" ]; then
    echo "SERVER :$1 DOWN (code=$code) — restarting"
    local windir=$(cygpath -w "$2")
    powershell -NoProfile -Command "Start-Process -WindowStyle Hidden cmd -ArgumentList '/c','cd /d $windir\\apps\\web && set PORT=$1&& bun run start > nul 2>&1'" >/dev/null 2>&1
    sleep 12
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:$1/game" 2>/dev/null)
    echo "SERVER :$1 after restart: $code"
    [ "$code" = "200" ] || return 1
  fi
  return 0
}

launch_chrome() { # $1=port $2=profile — echoes ws url or empty
  # Chrome MUST be detached from this function's stdout/stderr: callers capture
  # the ws url via $(launch_chrome ...), and a backgrounded child holding the
  # substitution pipe blocks the capture until Chrome EXITS (learned the hard
  # way — the first slice-A batch hung a full run on this).
  "$CHROME" \
    --remote-debugging-port=$1 --user-data-dir="$(cygpath -w "$2")" \
    --no-first-run --no-default-browser-check --window-size=1280,800 \
    --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
    about:blank >/dev/null 2>&1 &
  sleep 8
  local ws=""
  for i in 1 2 3 4 5 6 7 8; do
    ws=$(curl -s http://localhost:$1/json/version | grep -o 'ws://[^"]*')
    [ -n "$ws" ] && break
    sleep 2
  done
  echo "$ws"
}

run_probe() { # $1=arm(A|B) $2=run index — returns nonzero on missing evidence
  local arm="$1" run="$2"
  local PORT=$((PORT_BASE + (run % 4)))
  local target="http://localhost:3011/game$QS"
  [ "$arm" = "B" ] && target="http://localhost:3010/game$QS"
  local profile="$PROFILE_ROOT/probe-$BATCH_ID-$run-$arm"
  local report="$OUT/report-$run-$arm.json"
  local rc=1
  # A reused COLD_LOAD_OUT must never satisfy the evidence check with a STALE
  # report from a previous batch (Codex R19 round-2 finding 2).
  rm -f "$report"
  rm -rf "$profile"; mkdir -p "$profile"
  free_probe_port $PORT
  local ws=$(launch_chrome $PORT "$profile")
  if [ -z "$ws" ]; then
    kill_probe_chrome "$profile"
    sleep 3
    ws=$(launch_chrome $PORT "$profile")
  fi
  if [ -z "$ws" ]; then
    echo "RUN $run ARM $arm: FAILED (CDP never came up)"
  else
    cd "$CANDIDATE_DIR" && \
    bun apps/web/scripts/cold-load-probe.mjs "$ws" "$target" "$report" $COLD_LOAD_PROBE_EXTRA_ARGS 2>&1 | grep -E "INVALID" | head -1
    # PIPESTATUS[0] = the probe's own exit, not grep's (grep finding nothing
    # is the HAPPY path). Evidence = probe exited 0 AND the report exists.
    rc=${PIPESTATUS[0]}
    if [ "$rc" != "0" ]; then
      echo "RUN $run ARM $arm: FAILED (probe exit $rc)"
    elif [ ! -s "$report" ]; then
      echo "RUN $run ARM $arm: FAILED (no report written)"
      rc=1
    fi
  fi
  kill_probe_chrome "$profile"
  rm -rf "$profile"
  sleep 3
  [ "$rc" = "0" ] || { FAILED_RUNS=$((FAILED_RUNS + 1)); return 1; }
  return 0
}

if [ "$MODE" = "solo" ]; then
  for run in $(seq 1 "$COUNT"); do
    echo "=== SOLO RUN $run/$COUNT (arm $ARM, $BACKEND) ==="
    if [ "$ARM" = "A" ]; then srv_dir="$BASELINE_DIR"; srv_port=3011; else srv_dir="$CANDIDATE_DIR"; srv_port=3010; fi
    if ! ensure_server "$srv_port" "$srv_dir"; then
      echo "RUN $run ARM $ARM: FAILED (server :$srv_port dead)"
      # Delete any stale same-named report so skipped runs can't smuggle old
      # evidence into a later manifest (Codex R19 round-3 residual 1).
      rm -f "$OUT/report-$run-$ARM.json"
      FAILED_RUNS=$((FAILED_RUNS + 1))
      continue
    fi
    run_probe "$ARM" "$run" || true
  done
  echo "AB_RUNNER_DONE solo $ARM $BACKEND out=$OUT failed=$FAILED_RUNS"
  [ "$FAILED_RUNS" = "0" ] || exit 1
  exit 0
fi

for pair in $(seq 1 "$COUNT"); do
  if [ $((pair % 2)) -eq 1 ]; then order="AB"; else order="BA"; fi
  echo "=== PAIR $pair ($order) ==="
  pair_ok=1
  ensure_server 3011 "$BASELINE_DIR" || { echo "PAIR $pair: FAILED (baseline server dead)"; FAILED_RUNS=$((FAILED_RUNS + 1)); pair_ok=0; }
  ensure_server 3010 "$CANDIDATE_DIR" || { echo "PAIR $pair: FAILED (candidate server dead)"; FAILED_RUNS=$((FAILED_RUNS + 1)); pair_ok=0; }
  if [ "$pair_ok" != "1" ]; then
    # Delete stale same-named reports so the skipped pair can't enter the
    # manifest via existsSync (Codex R19 round-3 residual 1).
    rm -f "$OUT/report-$pair-A.json" "$OUT/report-$pair-B.json"
    continue
  fi
  if [ "$order" = "AB" ]; then
    run_probe A "$pair" || true; run_probe B "$pair" || true
  else
    run_probe B "$pair" || true; run_probe A "$pair" || true
  fi
done

# Build the pairs manifest for cold-load-paired-gate.mjs. A manifest failure
# is an evidence failure — it must flip the exit code (round-2 finding 2).
if ! OUT="$OUT" BACKEND="$BACKEND" COUNT="$COUNT" EXPECT_ACTOR="$COLD_LOAD_EXPECT_ACTOR" bun -e "
const fs = require('fs');
const out = process.env.OUT;
const pairs = [];
for (let p = 1; p <= Number(process.env.COUNT); p++) {
  const order = p % 2 === 1 ? 'AB' : 'BA';
  const a = out + '/report-' + p + '-A.json';
  const b = out + '/report-' + p + '-B.json';
  if (fs.existsSync(a) && fs.existsSync(b)) {
    pairs.push({ order, baseline: a, candidate: b });
  }
}
const manifest = { backend: process.env.BACKEND, pairs };
// Slice D authenticated lane: the gate's --slice-d mode requires this.
if (process.env.EXPECT_ACTOR) manifest.expectBootActor = process.env.EXPECT_ACTOR;
fs.writeFileSync(out + '/manifest.json', JSON.stringify(manifest, null, 1));
console.log('manifest pairs:', pairs.length);
"; then
  echo "MANIFEST GENERATION FAILED"
  FAILED_RUNS=$((FAILED_RUNS + 1))
fi
echo "AB_RUNNER_DONE pairs $BACKEND out=$OUT failed=$FAILED_RUNS"
[ "$FAILED_RUNS" = "0" ] || exit 1
