#!/usr/bin/env bash
#
# add-zone-to-cloudflare.sh — one-shot: add clawville.world to Cloudflare,
# review auto-imported DNS, swap nameservers at Namecheap, wait for active.
#
# Usage:
#   bash scripts/deploy/add-zone-to-cloudflare.sh
#
# Flags:
#   --yes         Skip the interactive "records look right?" pause (not recommended)
#   --skip-ns     Don't touch Namecheap; just create the zone and print the NS
#
# This script follows a deliberately safe, additive order:
#   1. POST /zones  → create the zone on Cloudflare (auto-imports existing DNS
#                     by querying your current nameservers)
#   2. List auto-imported records and pause for your review
#   3. On confirm: call namecheap.domains.dns.setCustom with the CF nameservers
#   4. Poll GET /zones/{id} until .status == "active"
#
# Respects the "never bulk-delete DNS" rule: this script only creates and sets,
# never deletes. If Cloudflare's auto-import misses a record, abort at step 2,
# add it manually in the CF UI, and re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"

SKIP_CONFIRM=false
SKIP_NS=false
for arg in "$@"; do
  case "$arg" in
    --yes) SKIP_CONFIRM=true ;;
    --skip-ns) SKIP_NS=true ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found."
  echo "       cp scripts/deploy/.env.deploy.example scripts/deploy/.env.deploy"
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${CF_API_TOKEN:?CF_API_TOKEN is empty in .env.deploy}"
: "${CF_ZONE_NAME:?CF_ZONE_NAME is empty}"
if [[ "$SKIP_NS" != true ]]; then
  : "${NAMECHEAP_API_USER:?NAMECHEAP_API_USER is empty (or pass --skip-ns)}"
  : "${NAMECHEAP_API_KEY:?NAMECHEAP_API_KEY is empty}"
  : "${NAMECHEAP_USERNAME:?NAMECHEAP_USERNAME is empty}"
fi

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found. Install with: scoop install $cmd (Windows) / brew install $cmd (macOS) / apt install $cmd (Linux)"
    exit 1
  fi
done

# Windows Git Bash curl uses schannel, which chokes on CRL revocation checks
# for some CAs. Detect and add --ssl-no-revoke so HTTPS calls actually work.
CURL_EXTRA=()
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) CURL_EXTRA+=(--ssl-no-revoke) ;;
esac

CF_API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json")

# ─── Figure out the account ID ──────────────────────────────────────────
echo "→ Looking up Cloudflare account..."
ACCT_RESP=$(curl -sS "${CURL_EXTRA[@]}" "${AUTH[@]}" "$CF_API/accounts")
ACCT_OK=$(echo "$ACCT_RESP" | jq -r '.success')
if [[ "$ACCT_OK" != "true" ]]; then
  echo "error: Cloudflare API rejected the token."
  echo "$ACCT_RESP" | jq '.errors'
  echo
  echo "The token needs these permissions:"
  echo "  - Zone > Zone > Edit (at account scope)"
  echo "  - Zone > DNS  > Edit (at account scope)"
  exit 1
fi

ACCT_ID=$(echo "$ACCT_RESP" | jq -r '.result[0].id')
ACCT_NAME=$(echo "$ACCT_RESP" | jq -r '.result[0].name')
echo "✓ Account: $ACCT_NAME ($ACCT_ID)"

# ─── Create or fetch the zone ───────────────────────────────────────────
EXISTING=$(curl -sS "${CURL_EXTRA[@]}" "${AUTH[@]}" "$CF_API/zones?name=$CF_ZONE_NAME")
ZONE_ID=$(echo "$EXISTING" | jq -r '.result[0].id // empty')

if [[ -n "$ZONE_ID" ]]; then
  ZONE_STATUS=$(echo "$EXISTING" | jq -r '.result[0].status')
  echo "✓ Zone $CF_ZONE_NAME already exists ($ZONE_ID, status=$ZONE_STATUS)"
else
  echo "→ Creating zone $CF_ZONE_NAME on account $ACCT_NAME..."
  PAYLOAD=$(jq -n \
    --arg name "$CF_ZONE_NAME" \
    --arg acct "$ACCT_ID" \
    '{name:$name, account:{id:$acct}, type:"full"}')

  CREATE_RESP=$(curl -sS -X POST "${AUTH[@]}" "$CF_API/zones" --data "$PAYLOAD")
  CREATE_OK=$(echo "$CREATE_RESP" | jq -r '.success')
  if [[ "$CREATE_OK" != "true" ]]; then
    echo "error: zone creation failed."
    echo "$CREATE_RESP" | jq '.errors'
    exit 1
  fi
  ZONE_ID=$(echo "$CREATE_RESP" | jq -r '.result.id')
  ZONE_STATUS=$(echo "$CREATE_RESP" | jq -r '.result.status')
  echo "✓ Zone created ($ZONE_ID, status=$ZONE_STATUS)"
fi

# ─── Fetch assigned nameservers ─────────────────────────────────────────
ZONE_DETAIL=$(curl -sS "${CURL_EXTRA[@]}" "${AUTH[@]}" "$CF_API/zones/$ZONE_ID")
mapfile -t CF_NS < <(echo "$ZONE_DETAIL" | jq -r '.result.name_servers[]')

if [[ ${#CF_NS[@]} -eq 0 ]]; then
  echo "error: could not read nameservers from zone detail"
  echo "$ZONE_DETAIL" | jq
  exit 1
fi

echo "✓ Cloudflare nameservers assigned:"
for ns in "${CF_NS[@]}"; do echo "    $ns"; done

# ─── Show auto-imported DNS records for review ─────────────────────────
echo
echo "→ Fetching auto-imported DNS records (Cloudflare pulled these from your"
echo "  current nameservers). REVIEW THIS LIST CAREFULLY — anything missing"
echo "  here will disappear when the NS swap propagates."
echo
RECORDS=$(curl -sS "${CURL_EXTRA[@]}" "${AUTH[@]}" "$CF_API/zones/$ZONE_ID/dns_records?per_page=100")
echo "$RECORDS" | jq -r '.result[] | "  \(.type)\t\(.name)\t→ \(.content)\t\(if .proxied then "(proxied)" else "(dns-only)" end)"' | column -t -s $'\t'

RECORD_COUNT=$(echo "$RECORDS" | jq -r '.result | length')
echo
echo "  Total records: $RECORD_COUNT"

# ─── Confirm before the irreversible NS swap ───────────────────────────
if [[ "$SKIP_NS" == true ]]; then
  echo
  echo "→ --skip-ns flag set. Stopping here."
  echo "  Manually update nameservers at your registrar to:"
  for ns in "${CF_NS[@]}"; do echo "    $ns"; done
  exit 0
fi

if [[ "$SKIP_CONFIRM" != true ]]; then
  echo
  echo "════════════════════════════════════════════════════════════════════"
  echo "  READ THIS BEFORE CONTINUING"
  echo "════════════════════════════════════════════════════════════════════"
  echo "  Pressing 'y' will call the Namecheap API to replace your nameservers"
  echo "  for $CF_ZONE_NAME with the Cloudflare nameservers above."
  echo
  echo "  This is LIVE and affects the current clawville.world / Railway"
  echo "  deployment. Cloudflare becomes authoritative for DNS."
  echo
  echo "  Cloudflare's auto-import should have captured every existing record"
  echo "  — confirm the list above is complete before proceeding. If anything"
  echo "  is missing, abort (n), add it in the CF UI, then re-run this script."
  echo "════════════════════════════════════════════════════════════════════"
  read -rp "  Continue with NS swap? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) : ;;
    *) echo "aborted."; exit 0 ;;
  esac
fi

# ─── Detect public IP for Namecheap ClientIp ───────────────────────────
PUBLIC_IP=$(curl -s4 "${CURL_EXTRA[@]}" https://api.ipify.org || curl -s4 "${CURL_EXTRA[@]}" https://icanhazip.com || curl -s4 "${CURL_EXTRA[@]}" https://checkip.amazonaws.com || true)
PUBLIC_IP="${PUBLIC_IP//$'\n'/}"
PUBLIC_IP="${PUBLIC_IP//$'\r'/}"
if [[ -z "$PUBLIC_IP" ]]; then
  echo "error: could not detect public IPv4 (needed for Namecheap ClientIp)"
  exit 1
fi
echo "→ Detected public IPv4: $PUBLIC_IP"
echo "  Make sure this IP is in your Namecheap API whitelist:"
echo "    https://ap.www.namecheap.com/settings/tools/apiaccess/"
echo

# ─── Split zone name into SLD + TLD ────────────────────────────────────
# clawville.world → SLD=clawville, TLD=world
SLD="${CF_ZONE_NAME%%.*}"
TLD="${CF_ZONE_NAME#*.}"

# Namecheap wants the NS list comma-separated
NS_CSV=$(IFS=,; echo "${CF_NS[*]}")

echo "→ Calling namecheap.domains.dns.setCustom for $SLD.$TLD..."
NC_URL="https://api.namecheap.com/xml.response"
NC_RESP=$(curl -sS "${CURL_EXTRA[@]}" --get "$NC_URL" \
  --data-urlencode "ApiUser=$NAMECHEAP_API_USER" \
  --data-urlencode "ApiKey=$NAMECHEAP_API_KEY" \
  --data-urlencode "UserName=$NAMECHEAP_USERNAME" \
  --data-urlencode "Command=namecheap.domains.dns.setCustom" \
  --data-urlencode "ClientIp=$PUBLIC_IP" \
  --data-urlencode "SLD=$SLD" \
  --data-urlencode "TLD=$TLD" \
  --data-urlencode "Nameservers=$NS_CSV")

if echo "$NC_RESP" | grep -q 'Status="OK"' && echo "$NC_RESP" | grep -q 'Updated="true"'; then
  echo "✓ Namecheap confirmed nameservers updated"
else
  echo "error: Namecheap API did not confirm success. Full response:"
  echo "$NC_RESP"
  echo
  if echo "$NC_RESP" | grep -qi "IP is not in the whitelist\|IP address is not valid"; then
    echo "  >>> Your public IP ($PUBLIC_IP) is not whitelisted."
    echo "  >>> Add it at https://ap.www.namecheap.com/settings/tools/apiaccess/"
    echo "  >>> then re-run this script."
  fi
  exit 1
fi

# ─── Poll Cloudflare until zone is active ──────────────────────────────
echo
echo "→ Waiting for Cloudflare to detect the NS change (this takes 5-30 min)..."
echo "  Polling every 30 seconds. Press Ctrl-C to stop waiting (zone will still"
echo "  activate on its own once DNS propagates)."
echo

ATTEMPTS=0
MAX_ATTEMPTS=80  # ~40 min
while (( ATTEMPTS < MAX_ATTEMPTS )); do
  ATTEMPTS=$((ATTEMPTS + 1))
  STATUS=$(curl -sS "${CURL_EXTRA[@]}" "${AUTH[@]}" "$CF_API/zones/$ZONE_ID" | jq -r '.result.status')
  printf "  [%02d/%02d] zone status: %s\n" "$ATTEMPTS" "$MAX_ATTEMPTS" "$STATUS"
  if [[ "$STATUS" == "active" ]]; then
    echo
    echo "════════════════════════════════════════════════════════════════════"
    echo "  ✓ $CF_ZONE_NAME is ACTIVE on Cloudflare"
    echo "════════════════════════════════════════════════════════════════════"
    echo "  Next steps:"
    echo "    1. Fill out remaining .env.deploy fields (HCLOUD_TOKEN if not yet)"
    echo "    2. bash scripts/deploy/provision-hetzner.sh"
    echo "    3. bash scripts/deploy/setup-cloudflare-dns.sh"
    echo "════════════════════════════════════════════════════════════════════"
    exit 0
  fi
  sleep 30
done

echo
echo "  Zone not yet active after $((MAX_ATTEMPTS * 30 / 60)) minutes."
echo "  This is fine — propagation can take longer for some registrars."
echo "  Check status manually:"
echo "    curl -sS -H 'Authorization: Bearer \$CF_API_TOKEN' \\"
echo "      $CF_API/zones/$ZONE_ID | jq -r .result.status"
