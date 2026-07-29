#!/bin/bash
# W-E3 full parity pack: guarded preflight, sequential catalog rows, matrix.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

export CV_PARITY_WEB_BASE="${CV_PARITY_WEB_BASE:-https://itachi222.tail06a01b.ts.net:9443}"
export CV_PARITY_API_BASE="${CV_PARITY_API_BASE:-https://itachi222.tail06a01b.ts.net:9444}"
export CV_PARITY_AUTH_STATE="${CV_PARITY_AUTH_STATE:-scripts/parity/out/auth/live-state.json}"
export CV_PARITY_GUEST_AUTH_STATE="${CV_PARITY_GUEST_AUTH_STATE:-scripts/parity/out/auth/guest-state.json}"

LOG="scripts/parity/out/full-pack-run.log"
mkdir -p scripts/parity/out
: > "$LOG"

# The staging-guarded helper is frozen verbatim and imports `postgres`, whose
# install lives under apps/api. Give only that command the Windows module path.
if ! API_NODE_MODULES_WIN="$(cygpath -w "$REPO_ROOT/apps/api/node_modules")"; then
  echo "[$(date +%H:%M:%S)] RESET MODULE PATH FAILED — refusing pack" | tee -a "$LOG"
  exit 1
fi
RESET_NODE_PATH="$API_NODE_MODULES_WIN"
if [ -n "${NODE_PATH:-}" ]; then
  RESET_NODE_PATH="$RESET_NODE_PATH;$NODE_PATH"
fi

# FIX-6: everything agent-browser-owned that is alive now belongs to the
# keepalive baseline. Never sweep it. Later cleanup only targets non-baseline
# processes that have survived for more than three minutes.
baseline_output="$(
  powershell.exe -NoProfile -Command \
    "\$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { \$_.Name -ieq 'agent-browser-win32-x64.exe' -or ((\$_.Name -match '^(chrome|chromium|msedge).*\\.exe$') -and ([string]\$_.CommandLine -match 'agent-browser')) } | ForEach-Object { \$_.ProcessId }" \
    2>&1
)"
baseline_code=$?
if [ "$baseline_code" -ne 0 ]; then
  printf '%s\n' "$baseline_output" | tr -d '\r' | tee -a "$LOG"
  echo "[$(date +%H:%M:%S)] KEEPALIVE BASELINE FAILED — refusing pack" | tee -a "$LOG"
  exit "$baseline_code"
fi
CV_PARITY_KEEPALIVE_PIDS="$(
  printf '%s\n' "$baseline_output" | tr -d '\r' | paste -sd, -
)"
if [ -z "$CV_PARITY_KEEPALIVE_PIDS" ]; then
  echo "[$(date +%H:%M:%S)] KEEPALIVE BASELINE EMPTY — refusing pack" | tee -a "$LOG"
  exit 1
fi
export CV_PARITY_KEEPALIVE_PIDS
echo "[$(date +%H:%M:%S)] KEEPALIVE BASELINE: $CV_PARITY_KEEPALIVE_PIDS" | tee -a "$LOG"

cleanup_agent_browser_orphans() {
  powershell.exe -NoProfile -Command '
    $ErrorActionPreference = "Stop"
    $baseline = @(
      ([string]$env:CV_PARITY_KEEPALIVE_PIDS -split ",") |
        Where-Object { $_ -match "^\d+$" } |
        ForEach-Object { [int]$_ }
    )
    $cutoff = (Get-Date).AddMinutes(-3)
    $killed = @()
    Get-CimInstance Win32_Process |
      Where-Object {
        ($_.Name -ieq "agent-browser-win32-x64.exe" -or
          (($_.Name -match "^(chrome|chromium|msedge).*\.exe$") -and
            ([string]$_.CommandLine -match "agent-browser"))) -and
        ($baseline -notcontains [int]$_.ProcessId) -and
        ($_.CreationDate -lt $cutoff)
      } |
      ForEach-Object {
        try {
          Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
          $killed += [int]$_.ProcessId
        } catch {
          Write-Output ("ORPHAN-CLEANUP skipped vanished PID " + $_.ProcessId)
        }
      }
    "ORPHAN-CLEANUP killed=" + $killed.Count +
      $(if ($killed.Count -gt 0) { " pids=" + ($killed -join ",") } else { "" })
  ' 2>&1 | tr -d '\r' | tee -a "$LOG"
}

if ! timeout 30 agent-browser session list >/dev/null 2>&1; then
  echo "[$(date +%H:%M:%S)] DAEMON UNRESPONSIVE before preflight — refusing pack" | tee -a "$LOG"
  exit 1
fi

# FIX-3/FIX-4 preflight: authenticate both profiles, re-mint anonymous guest
# state when stale, enforce live vCLAW floor, and reuse or create an open cash
# table.
preflight_output="$(bun scripts/parity/pack-preflight.ts 2>&1)"
preflight_code=$?
printf '%s\n' "$preflight_output" | tee -a "$LOG"
if [ "$preflight_code" -ne 0 ]; then
  echo "[$(date +%H:%M:%S)] PACK PREFLIGHT REFUSED (exit $preflight_code)" | tee -a "$LOG"
  exit "$preflight_code"
fi
cash_table_id="$(
  printf '%s\n' "$preflight_output" |
    sed -n 's/^PACK_CASH_TABLE_ID=//p' |
    tail -1
)"
if [ -z "$cash_table_id" ]; then
  echo "[$(date +%H:%M:%S)] PACK PREFLIGHT REFUSED: no cash table id emitted" | tee -a "$LOG"
  exit 1
fi
export CV_PARITY_CASH_TABLE_ID="$cash_table_id"
echo "[$(date +%H:%M:%S)] PACK CASH TABLE IN USE: $CV_PARITY_CASH_TABLE_ID" | tee -a "$LOG"

# Catalog is the only row inventory. A hand-maintained id file can silently
# drift, so derive the execution list from the module on every pack.
mapfile -t SCENARIO_IDS < <(
  bun -e "import { SCENARIO_CATALOG } from './scripts/parity/scenarios'; for (const scenario of SCENARIO_CATALOG) console.log(scenario.id);"
)
if [ "${#SCENARIO_IDS[@]}" -eq 0 ]; then
  echo "[$(date +%H:%M:%S)] CATALOG EMPTY — refusing pack" | tee -a "$LOG"
  exit 1
fi

total=0
proven=0
failed=0
blocked=0
other=0
for id in "${SCENARIO_IDS[@]}"; do
  [ -z "$id" ] && continue
  total=$((total+1))
  # Resume support: a persisted PASS result is final — skip the row.
  if grep -q '"status": "PASS"' "scripts/parity/out/results/$id.json" 2>/dev/null; then
    echo "[$(date +%H:%M:%S)] ROW $total: $id SKIP (already PASS)" | tee -a "$LOG"
    proven=$((proven+1))
    continue
  fi

  echo "[$(date +%H:%M:%S)] ROW $total: $id" | tee -a "$LOG"
  code=1
  out=""
  for attempt in 1 2 3; do
    # The fingerprint-shared harness guest can inherit an open drained demo
    # shoe after a crashed attempt. Reconcile it before every attempt.
    if NODE_PATH="$RESET_NODE_PATH" \
      bun scripts/parity/reset-guest-shoes.ts >> "$LOG" 2>&1; then
      :
    else
      reset_code=$?
      echo "[$(date +%H:%M:%S)] GUEST SHOE RESET FAILED (exit $reset_code) before $id attempt $attempt — aborting pack dirty-state protection" | tee -a "$LOG"
      exit "$reset_code"
    fi
    out="$(bun scripts/parity/run-parity.ts --live --scenario "$id" 2>&1)"
    code=$?
    printf '%s\n' "$out" >> "$LOG"
    # FIX-1b: --live now exits with this row's verdict, so exit 0 is a
    # certified PASS and retries stop immediately.
    [ "$code" -eq 0 ] && break
    retry_note=""
    [ "$attempt" -lt 3 ] && retry_note=" — retrying"
    echo "[$(date +%H:%M:%S)] ROW $total attempt $attempt failed (exit $code)$retry_note" | tee -a "$LOG"
  done

  result_path="scripts/parity/out/results/$id.json"
  verdict=""
  if [ -f "$result_path" ]; then
    verdict="$(
      bun -e \
        "const result = await Bun.file(process.argv[1]).json(); if (typeof result.status === 'string') console.log(result.status);" \
        "$result_path" 2>/dev/null
    )"
  fi
  # A catalog-level BLOCKED row can refuse before a result is written. Retain
  # output classification only for that no-artifact case; never let the
  # printed global matrix override a canonical row result.
  if [ -z "$verdict" ]; then
    verdict="$(
      printf '%s\n' "$out" |
        grep -oE "PROVEN|BLOCKED|UNPROVEN|FAILED|PASS|FAIL" |
        tail -1
    )"
  fi
  echo "[$(date +%H:%M:%S)] ROW-RESULT $id exit=$code verdict=${verdict:-none}" | tee -a "$LOG"

  cleanup_agent_browser_orphans
  if ! timeout 30 agent-browser session list >/dev/null 2>&1; then
    echo "[$(date +%H:%M:%S)] DAEMON UNRESPONSIVE after $id — aborting pack (rows would hang)" | tee -a "$LOG"
    break
  fi

  case "$verdict" in
    PROVEN|PASS) proven=$((proven+1));;
    BLOCKED) blocked=$((blocked+1));;
    FAILED|FAIL|UNPROVEN) failed=$((failed+1));;
    *) other=$((other+1));;
  esac
done

echo "RUNS COMPLETE: total=$total proven=$proven blocked=$blocked failed=$failed unclassified=$other" | tee -a "$LOG"
echo "=== EMIT MATRIX ===" | tee -a "$LOG"
bun scripts/parity/run-parity.ts --emit-matrix >> "$LOG" 2>&1
echo "MATRIX-EXIT=$?" | tee -a "$LOG"
echo "FULL-PACK-DONE"
