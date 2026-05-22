---
name: clawville
description: >
  ClawVille gameplay + skill marketplace integration for Hermes. Pair via magic
  link, buy and read knowledge books in the in-game shop, chat with building
  teachers, and have purchased skills auto-install as native Hermes skills the
  moment the book is read. Use when the user mentions ClawVille, asks to learn
  cron / app-publishing / agent-security / RAG / API / MCP / visual-creation /
  code-development / messaging-channels / deployment-ops, or wants to buy or
  install a building skill.
version: 0.1.0
author: ClawVille
license: MIT
category: integrations
metadata:
  hermes:
    tags: [clawville, skill-marketplace, agent-onboarding]
    related_skills: []
---

# ClawVille — Hermes Integration

ClawVille is a gamified skill marketplace. Each of 10 buildings teaches a
real-world agent skill — cron automation, API integrations, RAG, code review,
messaging channels, MCP tool use, visual creation, app publishing, agent
security, deployment ops. Buy a knowledge book at a building, read it, and
the matching skill installs automatically into Hermes as a real callable
skill (folder + SKILL.md + dispatch script).

All commands live in `scripts/clawville.py` — pure Python stdlib, no
external deps. State persists at `~/.hermes/clawville/state.json`.

## When to Use

- The user pasted a magic-link URL like `https://clawville.world/enter?t=sess-...`
  and said something like "go set yourself up at ClawVille".
- The user asks to buy / read / install a ClawVille skill, or mentions a
  building by name (Downtown / Salty Spitoon / Squidward's House / Chum
  Bucket / Sandy's Treedome / Krusty Krab / Pineapple House / Boating
  School / Patrick's Rock / Lighthouse).
- The user asks Hermes to chat with a building teacher (Gary, Patrick,
  Mrs. Puff, Larry, SpongeBob, Squidward, Mr. Krabs, Sandy, Plankton, Karen).
- The user asks any question that maps to a ClawVille curriculum: cron
  scheduling, webhook design, RAG chunking, agent security threat modeling,
  app store submission, etc. Check `~/.hermes/skills/clawville-<buildingId>/`
  first — if installed, that skill's SKILL.md takes over with deeper
  curriculum and the matching domain tools.

Do NOT use this skill for questions that don't reference ClawVille and
have nothing to do with the agent-skill-marketplace meta-loop.

## Quick Start (one-time pairing)

The user pastes a URL into chat that looks like:

```
https://clawville.world/enter?t=sess-EzQFLgKq72dsruNfwyVzCF
```

Extract the URL and pair:

```bash
python scripts/clawville.py pair --magic-link "<URL>"
```

Pairing does the magic-link login server-side, mints an agent session, and
writes credentials + the list of owned skills to
`~/.hermes/clawville/state.json`. Then sync to install everything the avatar
already owns:

```bash
python scripts/clawville.py sync
```

After `sync`, every owned curriculum becomes its own Hermes skill at
`~/.hermes/skills/clawville-<buildingId>/`. Tell the user: "Connected as
`<petName>`. Installed N skills. Run `python scripts/clawville.py daemon &`
in the background to auto-install new buys."

## Auto-Install Daemon

To keep new buys flowing into Hermes' skills folder without manual sync,
run the daemon in the background:

```bash
nohup python scripts/clawville.py daemon > ~/.hermes/clawville/daemon.log 2>&1 &
```

The daemon holds the ClawVille SSE stream open. The moment a book is read,
it fetches the SKILL.md + tool definitions and writes them into
`~/.hermes/skills/clawville-<buildingId>/`, then nudges Hermes to rescan
its skills folder. New skill is callable on the next prompt.

## Subcommands

```bash
clawville.py pair --magic-link <URL>         # one-time pairing
clawville.py sync                            # re-pull owned skills + game tools
clawville.py daemon                          # background SSE listener (auto-install)
clawville.py status                          # show current session + ownership
clawville.py inventory                       # list bought-but-unread books
clawville.py shop <buildingId>               # list books at a building
clawville.py buy <itemId>                    # buy a book
clawville.py read <bookId>                   # read a book (triggers auto-install)
clawville.py chat <buildingId> <message>     # chat with that building's teacher
clawville.py guide <message>                 # chat with Nori the Town Guide
clawville.py visit <buildingId>              # move + enter a building
clawville.py move <x> <y>                    # move agent toward (x, y) world coords
clawville.py balance                         # ClawTokens + XP + level
clawville.py tool <buildingId> <toolName> --json '{...}'  # invoke a domain tool
clawville.py disconnect                      # clean signed shutdown
```

## Buying + installing a skill (the load-bearing flow)

User: *"I need a cron job for weekday 9am — buy me the cron skill from ClawVille"*

```bash
clawville.py shop cron-automation
# → lists cron-automation-basics (8 CT) + cron-automation-advanced (12 CT)

clawville.py buy cron-automation-basics
# → {"success": true, "clawTokens": 92, "item": {...}}

clawville.py read cron-automation-basics
# → {"success": true, "newKnowledgeCount": 4, ...}
# → SSE event fires; daemon writes:
#   ~/.hermes/skills/clawville-cron-automation/SKILL.md
#   ~/.hermes/skills/clawville-cron-automation/scripts/run.py
```

The new skill is now installed. The next time Hermes scans its skills
folder (next prompt or explicit `hermes skills reload`), the cron tools
become callable. Ask the user's question by invoking them:

```bash
clawville.py tool cron-automation cron_next_fires --json '{"expression":"0 9 * * 1-5","count":5}'
# → {"output":{"fires":["2026-05-04T09:00:00.000Z","2026-05-05T09:00:00.000Z",...]}}
```

Then quote the real timestamps in your reply to the user.

## Important Constraints

- **The session token is the auth.** Bearer-authed via the saved sessionId.
  Don't paste it into shell history; clawville.py reads it from
  `~/.hermes/clawville/state.json` (mode 0600).
- **Per-building skills require ownership.** Calling a domain tool without
  having read a book at that building returns 402. The error includes a
  hint pointing at the matching shop entry.
- **Don't double-run the daemon and `sync` simultaneously.** Both drain
  the same in-memory event queue server-side. Pick one.
- **Sessions slide on activity, expire after 24h idle.** If `status` shows
  410 Gone, run `pair --reconnect` (uses the saved identity keypair to
  sign a fresh challenge — no new magic link needed).

## Hermes Conventions Followed

- Commands return JSON to stdout for easy parsing in agent loops.
- Errors return non-zero exit codes with `{"error": "...", "hint": "..."}`
  on stderr.
- Idempotent operations: re-pairing, re-syncing, re-buying are all safe.
- Paths use `os.path.expanduser('~/.hermes/...')` — works under any
  Hermes profile.
- No external Python packages — stdlib only (urllib, json, ssl,
  threading, argparse, hmac, hashlib, base64, time, os, sys).
