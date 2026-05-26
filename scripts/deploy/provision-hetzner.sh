#!/usr/bin/env bash
#
# provision-hetzner.sh — Create the ClawVille Hetzner Cloud VPS.
#
# Prerequisites:
#   1. hcloud CLI installed:        https://github.com/hetznercloud/cli
#      macOS:     brew install hcloud
#      Windows:   scoop install hcloud       (or download .exe from releases)
#      Linux:     see repo releases
#   2. scripts/deploy/.env.deploy filled in (copy from .env.deploy.example)
#
# What this script does (idempotent — safe to re-run):
#   • Creates a firewall allowing 22, 80, 443, 8000 (Coolify UI)
#   • Uploads your SSH public key to Hetzner (if not already there)
#   • Creates the CCX13 server (if not already there)
#   • Prints the IPv4 address for the next step
#
# Cost: CCX13 is billed hourly, ~$14/mo if run 24/7. Destroy with:
#   hcloud server delete clawville-prod

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found."
  echo "       copy .env.deploy.example → .env.deploy and fill it in."
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${HCLOUD_TOKEN:?HCLOUD_TOKEN is empty in .env.deploy}"
: "${SERVER_NAME:?SERVER_NAME is empty}"
: "${SERVER_TYPE:?SERVER_TYPE is empty}"
: "${SERVER_LOCATION:?SERVER_LOCATION is empty}"
: "${SERVER_IMAGE:?SERVER_IMAGE is empty}"
: "${SSH_KEY_NAME:?SSH_KEY_NAME is empty}"
: "${SSH_KEY_PATH:?SSH_KEY_PATH is empty}"

export HCLOUD_TOKEN

# Expand ~ in SSH key path
SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"

if ! command -v hcloud >/dev/null 2>&1; then
  echo "error: hcloud CLI not found. Install it first:"
  echo "  macOS:    brew install hcloud"
  echo "  Windows:  scoop install hcloud"
  echo "  Linux:    https://github.com/hetznercloud/cli/releases"
  exit 1
fi

if [[ ! -f "$SSH_KEY_PATH" ]]; then
  echo "error: SSH public key not found at $SSH_KEY_PATH"
  echo "       generate one with:  ssh-keygen -t ed25519 -C clawville-deploy"
  exit 1
fi

echo "→ Verifying Hetzner API token..."
hcloud server list >/dev/null

# ─── Firewall ────────────────────────────────────────────────────────────
FIREWALL_NAME="clawville-fw"
if hcloud firewall describe "$FIREWALL_NAME" >/dev/null 2>&1; then
  echo "✓ Firewall $FIREWALL_NAME already exists"
else
  echo "→ Creating firewall $FIREWALL_NAME..."
  hcloud firewall create --name "$FIREWALL_NAME"
  hcloud firewall add-rule "$FIREWALL_NAME" \
    --direction in --protocol tcp --port 22 --source-ips 0.0.0.0/0 --source-ips ::/0 \
    --description "ssh"
  hcloud firewall add-rule "$FIREWALL_NAME" \
    --direction in --protocol tcp --port 80 --source-ips 0.0.0.0/0 --source-ips ::/0 \
    --description "http"
  hcloud firewall add-rule "$FIREWALL_NAME" \
    --direction in --protocol tcp --port 443 --source-ips 0.0.0.0/0 --source-ips ::/0 \
    --description "https"
  hcloud firewall add-rule "$FIREWALL_NAME" \
    --direction in --protocol tcp --port 8000 --source-ips 0.0.0.0/0 --source-ips ::/0 \
    --description "coolify ui (remove after setup)"
  echo "✓ Firewall created"
fi

# ─── SSH Key ─────────────────────────────────────────────────────────────
if hcloud ssh-key describe "$SSH_KEY_NAME" >/dev/null 2>&1; then
  echo "✓ SSH key $SSH_KEY_NAME already in Hetzner"
else
  echo "→ Uploading SSH key from $SSH_KEY_PATH..."
  hcloud ssh-key create --name "$SSH_KEY_NAME" --public-key-from-file "$SSH_KEY_PATH"
  echo "✓ SSH key uploaded"
fi

# ─── Server ──────────────────────────────────────────────────────────────
if hcloud server describe "$SERVER_NAME" >/dev/null 2>&1; then
  echo "✓ Server $SERVER_NAME already exists"
else
  echo "→ Creating server $SERVER_NAME ($SERVER_TYPE, $SERVER_LOCATION)..."
  LABELS_ARG=()
  if [[ -n "${SERVER_LABELS:-}" ]]; then
    # SERVER_LABELS format: "key=val,key2=val2"
    IFS=',' read -ra LBL <<< "$SERVER_LABELS"
    for l in "${LBL[@]}"; do LABELS_ARG+=(--label "$l"); done
  fi
  hcloud server create \
    --name "$SERVER_NAME" \
    --type "$SERVER_TYPE" \
    --image "$SERVER_IMAGE" \
    --location "$SERVER_LOCATION" \
    --ssh-key "$SSH_KEY_NAME" \
    --firewall "$FIREWALL_NAME" \
    "${LABELS_ARG[@]}"
  echo "✓ Server created"
fi

IPV4=$(hcloud server ip "$SERVER_NAME")

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  ClawVille Hetzner server ready"
echo "════════════════════════════════════════════════════════════════════"
echo "  Name:     $SERVER_NAME"
echo "  Type:     $SERVER_TYPE"
echo "  Location: $SERVER_LOCATION"
echo "  IPv4:     $IPV4"
echo
echo "  Next steps:"
echo "    1. Point DNS:"
echo "         bash scripts/deploy/setup-cloudflare-dns.sh $IPV4"
echo
echo "    2. Install Coolify on the box:"
echo "         ssh root@$IPV4 'curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash'"
echo
echo "    3. Open the Coolify UI:"
echo "         http://$IPV4:8000    (or https://coolify.clawville.world after DNS)"
echo "════════════════════════════════════════════════════════════════════"
