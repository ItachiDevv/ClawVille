#!/usr/bin/env bash
#
# setup-cloudflare-dns.sh — Add DNS records pointing at the Hetzner box.
#
# Usage:
#   bash scripts/deploy/setup-cloudflare-dns.sh <SERVER_IPV4>
#
# Or, if you omit the IP, the script will pull it from hcloud:
#   bash scripts/deploy/setup-cloudflare-dns.sh
#
# What this script does (additive only — never deletes existing records):
#   • Creates A records for new.clawville.world, api-new.clawville.world,
#     and coolify.clawville.world, all pointing at the server IP.
#   • If a record with the same name already exists, it is UPDATED in place
#     (safe re-run).
#   • Records are created DNS-only (grey cloud) so Let's Encrypt can issue
#     certs via HTTP-01. You can flip them to proxied (orange) in the CF UI
#     after the site is live.
#
# It explicitly does NOT touch the existing clawville.world or
# api.clawville.world records that point at Railway. The cutover is a
# manual step once you've confirmed the new stack works.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found."
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${CF_API_TOKEN:?CF_API_TOKEN is empty in .env.deploy}"
: "${CF_ZONE_NAME:?CF_ZONE_NAME is empty}"
: "${CF_WEB_SUBDOMAIN:?CF_WEB_SUBDOMAIN is empty}"
: "${CF_API_SUBDOMAIN:?CF_API_SUBDOMAIN is empty}"
: "${CF_COOLIFY_SUBDOMAIN:?CF_COOLIFY_SUBDOMAIN is empty}"

PROXIED="${CF_PROXIED:-false}"

# ─── Resolve server IP ───────────────────────────────────────────────────
SERVER_IPV4="${1:-}"
if [[ -z "$SERVER_IPV4" ]]; then
  if command -v hcloud >/dev/null 2>&1 && [[ -n "${HCLOUD_TOKEN:-}" ]]; then
    export HCLOUD_TOKEN
    SERVER_IPV4=$(hcloud server ip "${SERVER_NAME:-clawville-prod}")
  fi
fi
if [[ -z "$SERVER_IPV4" ]]; then
  echo "error: server IPv4 not provided and could not be resolved from hcloud."
  echo "       usage: $0 <IPV4>"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl not found."; exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found. Install with: scoop install jq / brew install jq / apt install jq"
  exit 1
fi

# Windows Git Bash curl uses schannel which chokes on CRL revocation checks.
CURL_EXTRA=()
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) CURL_EXTRA+=(--ssl-no-revoke) ;;
esac

CF_API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json")

echo "→ Looking up zone $CF_ZONE_NAME..."
ZONE_RESP=$(curl -sS "${CURL_EXTRA[@]}" "${AUTH[@]}" "$CF_API/zones?name=$CF_ZONE_NAME")
ZONE_ID=$(echo "$ZONE_RESP" | jq -r '.result[0].id // empty')

if [[ -z "$ZONE_ID" ]]; then
  echo "error: zone $CF_ZONE_NAME not found on this Cloudflare account."
  echo "response: $ZONE_RESP"
  exit 1
fi
echo "✓ Zone ID: $ZONE_ID"

upsert_a() {
  local sub="$1" full rec_id payload
  if [[ "$sub" == "@" ]]; then
    full="$CF_ZONE_NAME"
  else
    full="${sub}.${CF_ZONE_NAME}"
  fi

  echo "→ Upserting A $full → $SERVER_IPV4 (proxied=$PROXIED)"
  rec_id=$(curl -sS "${CURL_EXTRA[@]}" "${AUTH[@]}" \
    "$CF_API/zones/$ZONE_ID/dns_records?type=A&name=$full" | \
    jq -r '.result[0].id // empty')

  payload=$(jq -n \
    --arg type "A" \
    --arg name "$full" \
    --arg content "$SERVER_IPV4" \
    --argjson proxied "$PROXIED" \
    --argjson ttl 1 \
    '{type:$type,name:$name,content:$content,proxied:$proxied,ttl:$ttl}')

  if [[ -n "$rec_id" ]]; then
    curl -sS "${CURL_EXTRA[@]}" -X PUT "${AUTH[@]}" \
      "$CF_API/zones/$ZONE_ID/dns_records/$rec_id" \
      --data "$payload" | jq -r '.success, .errors'
    echo "  ✓ updated existing record ($rec_id)"
  else
    curl -sS "${CURL_EXTRA[@]}" -X POST "${AUTH[@]}" \
      "$CF_API/zones/$ZONE_ID/dns_records" \
      --data "$payload" | jq -r '.success, .errors'
    echo "  ✓ created new record"
  fi
}

upsert_a "$CF_WEB_SUBDOMAIN"
upsert_a "$CF_API_SUBDOMAIN"
upsert_a "$CF_COOLIFY_SUBDOMAIN"

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Cloudflare DNS records created (DNS-only / grey cloud)"
echo "════════════════════════════════════════════════════════════════════"
echo "    https://${CF_WEB_SUBDOMAIN}.${CF_ZONE_NAME}         (web)"
echo "    https://${CF_API_SUBDOMAIN}.${CF_ZONE_NAME}    (api)"
echo "    https://${CF_COOLIFY_SUBDOMAIN}.${CF_ZONE_NAME}  (coolify admin)"
echo
echo "  Existing clawville.world / api.clawville.world records untouched."
echo "  Cutover is a manual swap after you verify the new stack works."
echo "════════════════════════════════════════════════════════════════════"
