# codex-decider (host sidecar)

A small Bun HTTP service on the PROD HOST (not in the Coolify container). It runs the Codex CLI, logged in with the
founder's ChatGPT plan (flat monthly, not per-call spend), to judge Trading Floor arena paper entries. The API calls it
from `apps/api/src/services/floor-arena/codex-entry.ts` (FEATURE_GATE `codex_arena_entry_shadow`). It is a SHADOW:
every answer is stored in `floor_arena_codex_entry` (migration 0085) and no trade reads it. The money report is
`apps/api/scripts/floor-arena-codex-report.ts`.

## API

- `POST /decide`, header `Authorization: Bearer <CODEX_DECIDER_TOKEN>`, body `{agentId, mint, packet}` (packet = compact
  numeric facts + the bot's strategy summary, max 4000 chars). Answer 200
  `{decision: 'enter'|'skip', confidence: 0..1, exit_room: 'yes'|'no', rug_risk: 'low'|'med'|'high', reasons: string[] (max 3), model, ms}`.
  Errors: 401 `unauthorized`, 400 `bad_request`, 413 `too_large`, 429 `dropped` (queue full, oldest waiting request
  dropped), 504 `timeout`, 502 `codex_failed` / `bad_output`.
- `GET /health`: `{ok, codexVersion, login: 'chatgpt'|'api_key'|'logged_out'|'unknown', model, running, queued, counts, ...}`.
  It never returns a token or the raw login text. `ok` is true only for a ChatGPT login.

Each decision runs, in a new empty temp dir, with stdin closed (= `< /dev/null`):

```
codex exec --skip-git-repo-check --ephemeral -s read-only [-m $CODEX_DECIDER_MODEL] -c model_reasoning_effort="low" \
  --output-schema decision.schema.json -o <tmp>/out.json "<one-line prompt>"
```

The deadline (default 90 s) includes the queue wait; on timeout the whole process group is killed. Concurrency
default 2; up to 8 requests wait; the API client waits 95 s and sends at most `FLOOR_ARENA_CODEX_MAX_PER_HOUR`
(default 60) calls per hour.

## Env

| Name | Default | Meaning |
|---|---|---|
| `CODEX_DECIDER_TOKEN` | (required, >= 24 chars) | shared secret; the API sends it as `FLOOR_ARENA_CODEX_DECIDER_TOKEN` |
| `CODEX_DECIDER_MODEL` | empty = codex default | `codex exec -m` model id |
| `CODEX_DECIDER_BIND` | `127.0.0.1:8790` | IPv4:port; `0.0.0.0` is refused |
| `CODEX_DECIDER_TIMEOUT_MS` | `90000` | per-request deadline, queue wait included |
| `CODEX_DECIDER_CONCURRENCY` | `2` | parallel codex runs |
| `CODEX_DECIDER_QUEUE_MAX` | `8` | waiting requests before drop-oldest |
| `CODEX_DECIDER_EFFORT` | `low` | `model_reasoning_effort` |
| `CODEX_DECIDER_BIN` | `codex` | codex binary |

API container env (Coolify, prod app): `FLOOR_ARENA_CODEX_DECIDER_URL=http://<gateway-ip>:8790` (unset = OFF, the
kill switch), `FLOOR_ARENA_CODEX_DECIDER_TOKEN=<same token>`, optional `FLOOR_ARENA_CODEX_MAX_PER_HOUR` (default 60).

## Bind address (reachable from the container, not public)

Bind to the gateway IP of the docker network that the API container is on. The host owns that IP on the docker
bridge interface (`br-...`), so the API container reaches it, and the public interface does not carry it.

```
API=$(docker ps --format '{{.Names}}' | grep <prod-api-app-uuid> | head -1)
docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} gw={{$v.Gateway}}{{"\n"}}{{end}}' "$API"
# e.g. "coolify gw=10.0.1.1"  -> CODEX_DECIDER_BIND=10.0.1.1:8790
ip -o -4 addr show | grep 10.0.1.1          # shows the br-... interface that owns the gateway IP
```

If `ufw` is active, allow only that bridge: `sudo ufw allow in on br-<id> to 10.0.1.1 port 8790 proto tcp`.
If docker recreates the network with a new gateway, the service fails to bind and restarts every 5 s until
`CODEX_DECIDER_BIND` is fixed.

## Install on the host (lead runs 1-6; the FOUNDER runs step 4)

```
# 1. service user
sudo useradd --system --create-home --home-dir /home/codexd --shell /bin/bash codexd
# 2. bun for that user
sudo -u codexd -H bash -lc 'curl -fsSL https://bun.sh/install | bash'
# 3. codex CLI, pinned to the desktop version (check the asset name on github.com/openai/codex/releases)
cd /tmp && curl -fsSLO https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-x86_64-unknown-linux-musl.tar.gz
tar xzf codex-x86_64-unknown-linux-musl.tar.gz && sudo install -m 0755 codex-x86_64-unknown-linux-musl /usr/local/bin/codex
codex --version
# 4. FOUNDER: one device login with the ChatGPT account (open the URL, type the code)
sudo -u codexd -H codex login --device-auth
sudo -u codexd -H codex login status        # expect "Logged in using ChatGPT"
# 5. code + env + unit
sudo mkdir -p /opt/codex-decider && sudo cp server.ts decision.schema.json /opt/codex-decider/
sudo install -m 0640 -o root -g codexd codex-decider.env.example /etc/codex-decider.env   # then edit it
sudo cp codex-decider.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now codex-decider && journalctl -u codex-decider -n 20 --no-pager
# 6. check from the API container (no curl needed)
docker exec "$API" bun -e "fetch('http://10.0.1.1:8790/health').then(r => r.text()).then(console.log)"
```

Do NOT copy the desktop `~/.codex/auth.json` to the host: one ChatGPT refresh token shared by two machines can be
rotated by one of them and log the other out. The host gets its own device login.

Turn it off: unset `FLOOR_ARENA_CODEX_DECIDER_URL` on the API (no calls), or `sudo systemctl stop codex-decider`
(calls then fail fast and are stored as `error`).

## Tests

`bun test infra/codex-decider` (pure parts: config, auth, queue drop, handler status mapping).
