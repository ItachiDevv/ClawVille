#!/bin/bash
# ClawVille D1 agent sandbox (security pass, 2026-09-30).
#
# Runs each hosted agent runtime (hermes-local, openclaw-local) in its OWN Docker network at a
# FIXED address, as a non-root user, with every capability dropped and no-new-privileges, and
# keeps host firewall rules so that:
#   - containers on the coolify network (the API) may open the runtime gateway port;
#   - the runtime may reach the model endpoint (CV_SBX_LLM_HOST:CV_SBX_LLM_PORT);
#   - the runtime may NOT reach any address of this host, RFC1918, CGNAT/tailnet or link-local
#     space (so no clawville-db, coolify-db, coolify-redis, API port, Coolify panel or sshd);
#   - the runtime keeps public internet egress (its tools stay usable inside the sandbox).
# The API reaches the runtimes at those fixed addresses when it runs with
# LOCAL_RUNTIME_TOPOLOGY=sandbox (apps/api/src/services/agent-session-config.ts).
#
# Idempotent. Installed as /usr/local/bin/cv-agent-sandbox.sh; the existing systemd timers
# (hermes-attach.timer / openclaw-attach.timer, OnBootSec=90 + every 120 s) run
# /usr/local/bin/{hermes,openclaw}-attach.sh, which exec this script. The runtime containers
# have NO Docker restart policy on purpose: after a reboot only this script starts them, and it
# always writes the firewall rules first.
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

HERMES_NET=cv-sbx-hermes;     HERMES_SUBNET=10.201.86.0/29; HERMES_IP=10.201.86.2; HERMES_PORT=8642
OPENCLAW_NET=cv-sbx-openclaw; OPENCLAW_SUBNET=10.201.87.0/29; OPENCLAW_IP=10.201.87.2; OPENCLAW_PORT=8643

log() { echo "[cv-agent-sandbox] $*"; }

ensure_network() { # name subnet
  local name=$1 subnet=$2 cur
  cur=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$name" 2>/dev/null || true)
  if [ -z "$cur" ]; then
    docker network create --driver bridge --ipv6=false --subnet "$subnet" \
      -o com.docker.network.bridge.name="$name" \
      -o com.docker.network.bridge.enable_icc=false \
      "$name" >/dev/null
    log "created network $name $subnet"
  elif [ "$cur" != "$subnet" ]; then
    log "network $name has subnet $cur, expected $subnet — refusing"; exit 1
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

firewall() {
  local api br; api=$(api_subnet); br=$(api_bridge)
  [ -n "$api" ] || { log "no IPv4 subnet on network $API_NET — refusing"; exit 1; }
  ip link show "$br" >/dev/null 2>&1 || { log "bridge $br of $API_NET not found — refusing"; exit 1; }

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
  #    The chain is rebuilt atomically (iptables-restore --noflush flushes only this chain).
  iptables -t mangle -N CV-SBX-EGRESS 2>/dev/null || true
  iptables-restore --noflush <<EOF
*mangle
:CV-SBX-EGRESS - [0:0]
-A CV-SBX-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A CV-SBX-EGRESS -m addrtype --dst-type LOCAL -j DROP
-A CV-SBX-EGRESS -d ${LLM_HOST}/32 -p tcp --dport ${LLM_PORT} -j RETURN
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

  # 2) API (coolify network) -> runtime gateway port, and the replies. DOCKER-USER runs before
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

# Recreate the container unless it already runs with exactly the sandbox settings.
needs_recreate() { # name expected-signature
  local sig running
  sig=$(docker inspect -f '{{.HostConfig.NetworkMode}}|{{.Config.User}}|{{.HostConfig.CapDrop}}|{{.HostConfig.SecurityOpt}}|{{.HostConfig.RestartPolicy.Name}}' "$1" 2>/dev/null || true)
  running=$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)
  [ "$sig" != "$2" ] || [ "$running" != "true" ]
}

ensure_hermes() {
  ensure_network "$HERMES_NET" "$HERMES_SUBNET"
  local expected="${HERMES_NET}|10000:10000|[ALL]|[no-new-privileges]|no"
  needs_recreate hermes-local "$expected" || return 0
  local key; key=$(cat /opt/hermes-data/.api-server-key)
  [ -n "$key" ] || { log "empty /opt/hermes-data/.api-server-key — refusing to start an unauthenticated gateway"; exit 1; }
  docker rm -f hermes-local >/dev/null 2>&1 || true
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
  log "hermes-local (re)started in $HERMES_NET at $HERMES_IP:$HERMES_PORT"
}

ensure_openclaw() {
  ensure_network "$OPENCLAW_NET" "$OPENCLAW_SUBNET"
  local expected="${OPENCLAW_NET}|1000:1000|[ALL]|[no-new-privileges]|no"
  needs_recreate openclaw-local "$expected" || return 0
  chmod 600 /opt/openclaw-data/openclaw.json
  docker rm -f openclaw-local >/dev/null 2>&1 || true
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
  log "openclaw-local (re)started in $OPENCLAW_NET at $OPENCLAW_IP:$OPENCLAW_PORT"
}

status() {
  for c in hermes-local openclaw-local; do
    docker inspect -f '{{.Name}} running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} net={{.HostConfig.NetworkMode}} user={{.Config.User}} capdrop={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} restart={{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null || echo "/$c absent"
  done
  iptables -t raw -S CV-SBX-RAW 2>/dev/null | sed 's/^/raw: /' || true
  iptables -t raw -S PREROUTING | sed -n 2p | sed 's/^/raw first rule: /'
  iptables -t mangle -S CV-SBX-EGRESS 2>/dev/null | sed 's/^/mangle: /' || true
  iptables -S DOCKER-USER | grep cv-sbx | sed 's/^/filter: /' || true
}

cmd="${1:-}"; target="${2:-all}"
# Both timers fire on the same tick; serialize so the check-then-insert rules never duplicate.
exec 9>/run/cv-agent-sandbox.lock
flock -w 60 9
case "$cmd" in
  ensure)
    firewall
    case "$target" in
      hermes) ensure_hermes ;;
      openclaw) ensure_openclaw ;;
      all) ensure_hermes; ensure_openclaw ;;
      *) echo "usage: $0 ensure hermes|openclaw|all" >&2; exit 2 ;;
    esac ;;
  firewall) firewall ;;
  status) status ;;
  *) echo "usage: $0 ensure hermes|openclaw|all | firewall | status" >&2; exit 2 ;;
esac
