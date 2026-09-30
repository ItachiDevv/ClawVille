#!/bin/bash
# ClawVille D1 agent sandbox (security pass, 2026-09-30).
#
# Runs each hosted agent runtime (hermes-local, openclaw-local) in its OWN Docker network at a
# FIXED address, as a non-root user, with every capability dropped and no-new-privileges, and
# keeps host firewall rules so that:
#   - containers on the coolify network (the API) may open the runtime gateway port;
#   - the runtime may reach ONLY an inference-only proxy (cv-sbx-llm-proxy, nginx, host network,
#     listening on the sandbox bridge gateway IP :11434) that forwards a fixed allowlist of
#     inference paths to the model endpoint (CV_SBX_LLM_HOST:CV_SBX_LLM_PORT) — never the model
#     server's management API (pull, delete, create, push, copy, blobs);
#   - the runtime may NOT reach any other address of this host, RFC1918, CGNAT/tailnet or
#     link-local space (so no clawville-db, coolify-db, coolify-redis, API port, Coolify panel,
#     sshd or model server directly);
#   - the runtime keeps public internet egress (its tools stay usable inside the sandbox).
# The API reaches the runtimes at the fixed addresses when it runs with
# LOCAL_RUNTIME_TOPOLOGY=sandbox (apps/api/src/services/agent-session-config.ts).
#
# FAIL CLOSED: a runtime container that does not match the sandbox settings exactly is removed
# FIRST, before any other step, so an error later in the run leaves no runtime serving prompts.
#
# Idempotent. Installed as /usr/local/bin/cv-agent-sandbox.sh; the systemd timers
# hermes-attach.timer / openclaw-attach.timer (OnBootSec=90, every 120 s) run
# /usr/local/bin/{hermes,openclaw}-attach.sh, which exec this script. The runtime containers
# have NO Docker restart policy on purpose: after a reboot only this script starts them, and it
# always writes and verifies the firewall first.
#
# Usage: cv-agent-sandbox.sh ensure hermes|openclaw|all
#        cv-agent-sandbox.sh firewall
#        cv-agent-sandbox.sh status
# Config (optional): /etc/cv-agent-sandbox.env may set CV_SBX_LLM_HOST, CV_SBX_LLM_PORT.
# Rollback: docs/DEPLOY-HETZNER.md, "Hosted agent runtimes (D1 sandbox)".
set -euo pipefail

[ -r /etc/cv-agent-sandbox.env ] && . /etc/cv-agent-sandbox.env
LLM_HOST="${CV_SBX_LLM_HOST:-100.75.223.14}"
LLM_PORT="${CV_SBX_LLM_PORT:-11434}"
API_NET="coolify"
PROXY_NAME=cv-sbx-llm-proxy
PROXY_IMAGE="nginxinc/nginx-unprivileged@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0"
PROXY_PORT=11434
PROXY_CONF=/etc/cv-agent-sandbox/llm-proxy.conf

HERMES_NET=cv-sbx-hermes;     HERMES_SUBNET=10.201.86.0/29; HERMES_GW=10.201.86.1; HERMES_IP=10.201.86.2; HERMES_PORT=8642
OPENCLAW_NET=cv-sbx-openclaw; OPENCLAW_SUBNET=10.201.87.0/29; OPENCLAW_GW=10.201.87.1; OPENCLAW_IP=10.201.87.2; OPENCLAW_PORT=8643

HERMES_SIG="${HERMES_NET}|${HERMES_NET}=${HERMES_IP};|10000:10000|[ALL]|[]|false|[no-new-privileges]|no"
OPENCLAW_SIG="${OPENCLAW_NET}|${OPENCLAW_NET}=${OPENCLAW_IP};|1000:1000|[ALL]|[]|false|[no-new-privileges]|no"

log() { echo "[cv-agent-sandbox] $*"; }
die() { log "$*"; exit 1; }

# ---- container checks -------------------------------------------------------------------------
container_sig() {
  docker inspect -f '{{.HostConfig.NetworkMode}}|{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}};{{end}}|{{.Config.User}}|{{.HostConfig.CapDrop}}|{{.HostConfig.CapAdd}}|{{.HostConfig.Privileged}}|{{.HostConfig.SecurityOpt}}|{{.HostConfig.RestartPolicy.Name}}' "$1" 2>/dev/null || true
}
is_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]; }

# Remove a container and PROVE it is gone; a runtime that cannot be removed is a hard failure.
remove_container() { # name reason
  docker inspect "$1" >/dev/null 2>&1 || return 0
  docker rm -f "$1" >/dev/null 2>&1 || true
  if docker inspect "$1" >/dev/null 2>&1; then
    docker kill "$1" >/dev/null 2>&1 || true
    is_running "$1" && die "FAILED to stop $1 ($2) — it may still be serving; stop it by hand"
    die "FAILED to remove the stopped container $1 ($2)"
  fi
  log "removed $1 ($2)"
}

# Remove a runtime that is not EXACTLY the sandboxed shape (legacy shared-netns runtime, an extra
# network attachment, a missing hardening flag) or not running. Runs before anything else.
quarantine() { # name expected-signature
  local sig; sig=$(container_sig "$1")
  if [ -n "$sig" ] && { [ "$sig" != "$2" ] || ! is_running "$1"; }; then
    remove_container "$1" "not the sandboxed shape or not running"
  fi
}

# The sandbox boundary is the mangle egress chain + its PREROUTING jump.
egress_intact() {
  iptables -t mangle -C PREROUTING -i cv-sbx-+ -j CV-SBX-EGRESS 2>/dev/null &&
    [ "$(iptables -t mangle -S CV-SBX-EGRESS 2>/dev/null | grep -c -- '-j DROP')" -ge 9 ]
}

# ---- networks ---------------------------------------------------------------------------------
ensure_network() { # name subnet only-allowed-container
  local name=$1 subnet=$2 allowed=$3 cur opts c
  cur=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$name" 2>/dev/null || true)
  if [ -z "$cur" ]; then
    docker network create --driver bridge --ipv6=false --subnet "$subnet" \
      -o com.docker.network.bridge.name="$name" \
      -o com.docker.network.bridge.enable_icc=false \
      "$name" >/dev/null
    log "created network $name $subnet"
  fi
  opts=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{.EnableIPv6}}|{{.Internal}}' "$name")
  [ "$opts" = "${subnet}|${name}|false|false|false" ] || die "network $name has unexpected settings ($opts) — refusing"
  ip link show "$name" >/dev/null 2>&1 || die "bridge interface $name missing — refusing"
  # br_netfilter is not loaded, so traffic between containers on one bridge never reaches
  # iptables: nothing but the runtime itself may sit on its sandbox network.
  for c in $(docker network inspect -f '{{range $k,$v := .Containers}}{{$v.Name}} {{end}}' "$name"); do
    [ "$c" = "$allowed" ] && continue
    docker network disconnect -f "$name" "$c" >/dev/null 2>&1 || true
    log "disconnected foreign container $c from $name"
  done
  local left
  left=$(docker network inspect -f '{{range $k,$v := .Containers}}{{$v.Name}} {{end}}' "$name" | tr ' ' '\n' | grep -v -x -e "$allowed" -e '' || true)
  if [ -n "$left" ]; then
    remove_container "$allowed" "foreign container still on $name"
    die "could not disconnect $(echo $left) from $name — $allowed stopped"
  fi
}

api_subnet() {
  docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$API_NET" | tr ' ' '\n' | grep -m1 '\.' || true
}

api_bridge() {
  local name id
  name=$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$API_NET" 2>/dev/null || true)
  if [ -z "$name" ] || [ "$name" = "<no value>" ]; then
    id=$(docker network inspect -f '{{.Id}}' "$API_NET"); name="br-${id:0:12}"
  fi
  echo "$name"
}

ensure_rule() { # table chain rule...
  local table=$1 chain=$2; shift 2
  iptables -t "$table" -C "$chain" "$@" 2>/dev/null || iptables -t "$table" -I "$chain" 1 "$@"
}

# ---- firewall ---------------------------------------------------------------------------------
firewall() {
  local api br; api=$(api_subnet); br=$(api_bridge)
  [ -n "$api" ] || die "no IPv4 subnet on network $API_NET — refusing"
  ip link show "$br" >/dev/null 2>&1 || die "bridge $br of $API_NET not found — refusing"

  # 0) Docker (28+) appends raw PREROUTING rules that DROP any packet for a container IP arriving
  #    from another interface ("direct routing protection"). Punch exactly one hole per runtime:
  #    API bridge -> runtime gateway port, plus the replies. CV-SBX-RAW must stay the FIRST rule of
  #    raw PREROUTING (Docker appends below it); re-inserted at the top whenever it is not.
  iptables -t raw -N CV-SBX-RAW 2>/dev/null || true
  iptables-restore --noflush <<EOF
*raw
:CV-SBX-RAW - [0:0]
-A CV-SBX-RAW -i ${br} -s ${api} -d ${HERMES_IP}/32 -p tcp --dport ${HERMES_PORT} -j ACCEPT
-A CV-SBX-RAW -i ${HERMES_NET} -s ${HERMES_IP}/32 -d ${api} -p tcp --sport ${HERMES_PORT} -j ACCEPT
-A CV-SBX-RAW -i ${br} -s ${api} -d ${OPENCLAW_IP}/32 -p tcp --dport ${OPENCLAW_PORT} -j ACCEPT
-A CV-SBX-RAW -i ${OPENCLAW_NET} -s ${OPENCLAW_IP}/32 -d ${api} -p tcp --sport ${OPENCLAW_PORT} -j ACCEPT
COMMIT
EOF
  if [ "$(iptables -t raw -S PREROUTING | sed -n 2p)" != "-A PREROUTING -j CV-SBX-RAW" ]; then
    while iptables -t raw -D PREROUTING -j CV-SBX-RAW 2>/dev/null; do :; done
    iptables -t raw -I PREROUTING 1 -j CV-SBX-RAW
  fi

  # 1) Sandbox egress policy. mangle PREROUTING runs before routing, before Docker's and
  #    Tailscale's filter chains (ts-forward accepts anything bound for tailscale0 ahead of
  #    DOCKER-USER), and before INPUT, so one chain covers forwarded AND host-local targets.
  #    The only host-local target allowed is the inference proxy on the runtime's OWN bridge
  #    gateway. The chain is rebuilt atomically (iptables-restore --noflush flushes only it).
  iptables -t mangle -N CV-SBX-EGRESS 2>/dev/null || true
  iptables-restore --noflush <<EOF
*mangle
:CV-SBX-EGRESS - [0:0]
-A CV-SBX-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A CV-SBX-EGRESS -i ${HERMES_NET} -d ${HERMES_GW}/32 -p tcp --dport ${PROXY_PORT} -j RETURN
-A CV-SBX-EGRESS -i ${OPENCLAW_NET} -d ${OPENCLAW_GW}/32 -p tcp --dport ${PROXY_PORT} -j RETURN
-A CV-SBX-EGRESS -m addrtype --dst-type LOCAL -j DROP
-A CV-SBX-EGRESS -d 0.0.0.0/8 -j DROP
-A CV-SBX-EGRESS -d 10.0.0.0/8 -j DROP
-A CV-SBX-EGRESS -d 100.64.0.0/10 -j DROP
-A CV-SBX-EGRESS -d 127.0.0.0/8 -j DROP
-A CV-SBX-EGRESS -d 169.254.0.0/16 -j DROP
-A CV-SBX-EGRESS -d 172.16.0.0/12 -j DROP
-A CV-SBX-EGRESS -d 192.168.0.0/16 -j DROP
-A CV-SBX-EGRESS -d 224.0.0.0/3 -j DROP
-A CV-SBX-EGRESS -j RETURN
COMMIT
EOF
  ensure_rule mangle PREROUTING -i cv-sbx-+ -j CV-SBX-EGRESS

  # 2) The proxy is a host process (host network); ufw's INPUT policy is DROP, so accept exactly
  #    runtime bridge -> its own gateway IP :PROXY_PORT.
  ensure_rule filter INPUT -i "$HERMES_NET" -d "${HERMES_GW}/32" -p tcp --dport "$PROXY_PORT" -j ACCEPT
  ensure_rule filter INPUT -i "$OPENCLAW_NET" -d "${OPENCLAW_GW}/32" -p tcp --dport "$PROXY_PORT" -j ACCEPT

  # 3) API (coolify network) -> runtime gateway port, and the replies. DOCKER-USER runs before
  #    Docker's own inter-network isolation, which would otherwise drop this routed traffic.
  ensure_rule filter DOCKER-USER -s "$api" -d "${HERMES_IP}/32" -o "$HERMES_NET" -p tcp --dport "$HERMES_PORT" \
    -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
  ensure_rule filter DOCKER-USER -i "$HERMES_NET" -s "${HERMES_IP}/32" -d "$api" -p tcp --sport "$HERMES_PORT" \
    -m conntrack --ctstate ESTABLISHED -j ACCEPT
  ensure_rule filter DOCKER-USER -s "$api" -d "${OPENCLAW_IP}/32" -o "$OPENCLAW_NET" -p tcp --dport "$OPENCLAW_PORT" \
    -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
  ensure_rule filter DOCKER-USER -i "$OPENCLAW_NET" -s "${OPENCLAW_IP}/32" -d "$api" -p tcp --sport "$OPENCLAW_PORT" \
    -m conntrack --ctstate ESTABLISHED -j ACCEPT
}

# Refuse to start a runtime unless the egress policy is attached for its bridge.
verify_firewall() { # bridge
  egress_intact || die "egress jump or chain missing — refusing to start $1"
  case "$1" in cv-sbx-*) : ;; *) die "bridge $1 does not match cv-sbx-+ — refusing" ;; esac
  ip link show "$1" >/dev/null 2>&1 || die "bridge $1 missing — refusing"
}

# ---- inference-only model proxy ---------------------------------------------------------------
write_proxy_conf() {
  local up="http://${LLM_HOST}:${LLM_PORT}" tmp
  mkdir -p /etc/cv-agent-sandbox
  tmp=$(mktemp)
  {
    echo "# Generated by cv-agent-sandbox.sh (D1). Inference-only proxy for the sandboxed agent runtimes."
    echo "# Anything not listed returns 403: no pull/push/delete/create/copy/blobs on the model server."
    echo "server {"
    echo "  listen ${HERMES_GW}:${PROXY_PORT};"
    echo "  listen ${OPENCLAW_GW}:${PROXY_PORT};"
    echo "  server_tokens off;"
    echo "  client_max_body_size 4m;"
    echo "  proxy_http_version 1.1;"
    echo "  proxy_set_header Host ${LLM_HOST}:${LLM_PORT};"
    echo "  proxy_set_header Connection \"\";"
    echo "  proxy_buffering off;"
    echo "  proxy_read_timeout 300s;"
    for p in /v1/chat/completions /v1/completions /v1/embeddings /api/chat /api/generate /api/embed /api/embeddings /api/show; do
      echo "  location = ${p} { limit_except POST { deny all; } proxy_pass ${up}; }"
    done
    for p in /v1/models /api/tags /api/version; do
      echo "  location = ${p} { limit_except GET { deny all; } proxy_pass ${up}; }"
    done
    echo "  location / { return 403; }"
    echo "}"
  } > "$tmp"
  if ! cmp -s "$tmp" "$PROXY_CONF" 2>/dev/null; then
    install -m 0644 "$tmp" "$PROXY_CONF"; rm -f "$tmp"; return 0   # changed
  fi
  rm -f "$tmp"; return 1                                             # unchanged
}

ensure_proxy() {
  local changed=0
  write_proxy_conf && changed=1
  if [ "$changed" = 1 ] || ! is_running "$PROXY_NAME"; then
    docker rm -f "$PROXY_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$PROXY_NAME" --network host --restart unless-stopped \
      --read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 128 --memory 256m \
      -v "$PROXY_CONF:/etc/nginx/conf.d/default.conf:ro" \
      "$PROXY_IMAGE" >/dev/null
    log "$PROXY_NAME (re)started on ${HERMES_GW}/${OPENCLAW_GW}:${PROXY_PORT} -> ${LLM_HOST}:${LLM_PORT}"
  fi
}

# Point each runtime's model endpoint at its gateway proxy. Returns 0 when the file changed.
point_hermes_at_proxy() {
  local f=/opt/hermes-data/config.yaml want="http://${HERMES_GW}:${PROXY_PORT}/v1" before
  before=$(sha256sum "$f")
  sed -i -E "s#^([[:space:]]*base_url:[[:space:]]*)http://[^[:space:]]+:[0-9]+/v1[[:space:]]*\$#\1${want}#" "$f"
  [ "$(grep -cE "^[[:space:]]*base_url:[[:space:]]*${want}[[:space:]]*\$" "$f")" = 1 ] || die "hermes config.yaml base_url is not ${want} — refusing to start hermes"
  [ "$(sha256sum "$f")" != "$before" ]
}

point_openclaw_at_proxy() {
  local f=/opt/openclaw-data/openclaw.json want="http://${OPENCLAW_GW}:${PROXY_PORT}/v1"
  python3 - "$f" "$want" <<'PY'
import json, sys
path, want = sys.argv[1], sys.argv[2]
try:
    with open(path) as fh:
        cfg = json.load(fh)
except Exception:
    sys.exit(4)
provs = cfg.get("models", {}).get("providers", {})
if not provs:
    sys.exit(3)
changed = False
for p in provs.values():
    if p.get("baseUrl") != want:
        p["baseUrl"] = want
        changed = True
if changed:
    with open(path, "w") as fh:   # same inode: keeps owner (uid 1000) and mode
        json.dump(cfg, fh, indent=2)
        fh.write("\n")
sys.exit(0 if changed else 1)
PY
}

# ---- runtimes ---------------------------------------------------------------------------------
start_hermes() {
  local key; key=$(cat /opt/hermes-data/.api-server-key)
  [ -n "$key" ] || die "empty /opt/hermes-data/.api-server-key — refusing to start an unauthenticated gateway"
  verify_firewall "$HERMES_NET"
  # Direct entrypoint (no s6 /init): s6 needs root + capabilities; the gateway itself does not.
  docker run -d --name hermes-local \
    --network "$HERMES_NET" --ip "$HERMES_IP" \
    --user 10000:10000 --cap-drop ALL --security-opt no-new-privileges \
    --restart no --pids-limit 512 --memory 2g \
    --entrypoint /opt/hermes/.venv/bin/hermes \
    -e HOME=/opt/data -e HERMES_GATEWAY_NO_SUPERVISE=1 \
    -e API_SERVER_ENABLED=true -e API_SERVER_KEY="$key" \
    -e API_SERVER_PORT="$HERMES_PORT" -e API_SERVER_HOST=0.0.0.0 \
    -v /opt/hermes-data:/opt/data \
    hermes-agent gateway run --no-supervise >/dev/null
  log "hermes-local started in $HERMES_NET at $HERMES_IP:$HERMES_PORT"
}

start_openclaw() {
  verify_firewall "$OPENCLAW_NET"
  docker run -d --name openclaw-local \
    --network "$OPENCLAW_NET" --ip "$OPENCLAW_IP" \
    --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
    --restart no --pids-limit 512 --memory 2g \
    --health-cmd "node -e \"fetch('http://127.0.0.1:${OPENCLAW_PORT}/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
    --health-interval 30s --health-timeout 5s --health-retries 5 --health-start-period 20s \
    -v /opt/openclaw-data:/home/node/.openclaw \
    -e OPENCLAW_GATEWAY_PORT="$OPENCLAW_PORT" \
    -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    openclaw:local >/dev/null
  log "openclaw-local started in $OPENCLAW_NET at $OPENCLAW_IP:$OPENCLAW_PORT"
}

ensure() { # hermes|openclaw|all
  local want_h=0 want_o=0
  case "$1" in hermes) want_h=1 ;; openclaw) want_o=1 ;; all) want_h=1; want_o=1 ;;
    *) echo "usage: $0 ensure hermes|openclaw|all" >&2; exit 2 ;; esac
  # Fail closed first: nothing unsandboxed keeps serving if a later step fails.
  [ $want_h = 1 ] && quarantine hermes-local "$HERMES_SIG"
  [ $want_o = 1 ] && quarantine openclaw-local "$OPENCLAW_SIG"
  # A runtime that was alive while the egress policy was missing or incomplete (firewall reload,
  # manual flush) may hold connections the policy would refuse; RELATED/ESTABLISHED would keep them.
  # Remove BOTH runtimes before the rules are rebuilt; they restart below with the policy in place.
  if ! egress_intact; then
    remove_container hermes-local "egress policy was missing"
    remove_container openclaw-local "egress policy was missing"
  fi
  ensure_network "$HERMES_NET" "$HERMES_SUBNET" hermes-local
  ensure_network "$OPENCLAW_NET" "$OPENCLAW_SUBNET" openclaw-local
  firewall
  ensure_proxy
  if [ $want_h = 1 ]; then
    if point_hermes_at_proxy; then remove_container hermes-local "model URL moved to the proxy"; fi
    is_running hermes-local || start_hermes
  fi
  if [ $want_o = 1 ]; then
    chmod 600 /opt/openclaw-data/openclaw.json
    local rc=0; point_openclaw_at_proxy || rc=$?
    case $rc in
      0) remove_container openclaw-local "model URL moved to the proxy" ;;
      1) : ;;
      *) die "openclaw.json unreadable or has no model providers (rc=$rc) — refusing to start openclaw" ;;
    esac
    is_running openclaw-local || start_openclaw
  fi
}

status() {
  for c in hermes-local openclaw-local; do
    docker inspect -f '{{.Name}} running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} nets={{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}};{{end}} user={{.Config.User}} capdrop={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} restart={{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null || echo "/$c absent"
  done
  docker inspect -f '{{.Name}} running={{.State.Running}} net={{.HostConfig.NetworkMode}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}}' "$PROXY_NAME" 2>/dev/null || echo "/$PROXY_NAME absent"
  iptables -t raw -S CV-SBX-RAW 2>/dev/null | sed 's/^/raw: /' || true
  iptables -t raw -S PREROUTING | sed -n 2p | sed 's/^/raw first rule: /'
  iptables -t mangle -S CV-SBX-EGRESS 2>/dev/null | sed 's/^/mangle: /' || true
  iptables -S INPUT | grep cv-sbx | sed 's/^/filter: /' || true
  iptables -S DOCKER-USER | grep cv-sbx | sed 's/^/filter: /' || true
}

cmd="${1:-}"; target="${2:-all}"
# Both timers fire on the same tick; serialize so the check-then-insert rules never duplicate.
exec 9>/run/cv-agent-sandbox.lock
flock -w 60 9
case "$cmd" in
  ensure) ensure "$target" ;;
  firewall) firewall ;;
  status) status ;;
  *) echo "usage: $0 ensure hermes|openclaw|all | firewall | status" >&2; exit 2 ;;
esac
