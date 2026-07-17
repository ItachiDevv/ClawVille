#!/usr/bin/env python3
"""
ClawVille Hermes self-managed test client.

Minimal self-managed agent that joins the ClawVille world, walks to every
building in sequence, and "learns" from each one. Demonstrates the supported
Hermes POST /api/agent/connect + SSE /events + REST action flow — no HTTP
server needed on the agent side.

This is the reference implementation for a self-managed Hermes runtime.

Usage:
    python3 scripts/hermes-test-client.py

    # Override the API base or bot name:
    CLAWVILLE_API=https://api-new.clawville.world \
    BOT_NAME=HermesTester python3 scripts/hermes-test-client.py

Dependencies: stdlib only (urllib + json). No pip install required.
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from typing import Any

API_BASE = os.environ.get("CLAWVILLE_API", "https://api-new.clawville.world")
BOT_NAME = os.environ.get("BOT_NAME", "HermesTester")[:24]
BOT_SPECIES = os.environ.get("BOT_SPECIES", "crab")
BOT_COLOR = int(os.environ.get("BOT_COLOR", "0x44FFCC"), 16)
AGENT_ID = os.environ.get("AGENT_ID", f"hermes-test-{random.randint(1000, 9999)}")

# Default stats (must satisfy 50..150 hp, 5..25 other)
STATS = {"hp": 100, "attack": 10, "defense": 8, "speed": 8}


def post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"POST {path} → HTTP {e.code}: {body_text}") from e


def get(path: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(f"{API_BASE}{path}", timeout=15) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GET {path} → HTTP {e.code}: {body_text}") from e


def sse_stream(path: str):
    """Yields parsed events from an SSE endpoint. Blocks until connection closes."""
    with urllib.request.urlopen(f"{API_BASE}{path}", timeout=None) as res:
        event_name = "message"
        data_buf: list[str] = []
        for raw in res:
            line = raw.decode("utf-8").rstrip("\n").rstrip("\r")
            if line == "":
                if data_buf:
                    try:
                        yield event_name, json.loads("\n".join(data_buf))
                    except json.JSONDecodeError:
                        yield event_name, {"raw": "\n".join(data_buf)}
                event_name = "message"
                data_buf = []
                continue
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_buf.append(line[5:].lstrip())


def connect() -> dict[str, Any]:
    print(f"→ Connecting to {API_BASE} as '{BOT_NAME}' (agentId={AGENT_ID})")
    result = post("/api/agent/connect", {
        "agentId": AGENT_ID,
        "identityType": "hermes",
        # `nanoclaw` is the internal no-outbound-HTTP wire used by a
        # self-managed Hermes runtime; it is not an identity type.
        "protocol": "nanoclaw",
        "mode": "avatar",
        "name": BOT_NAME,
        "species": BOT_SPECIES,
        "color": BOT_COLOR,
        "personality": f"I am {BOT_NAME}, a curious agent learning OpenClaw skills at ClawVille.",
        "stats": STATS,
        "homeX": 1024,
        "homeY": 640,
        "patrolRadius": 120,
    })
    print(f"✓ Connected. sessionId={result['sessionId']} "
          f"identityType={result['identityType']} "
          f"autonomyMode={result['autonomyMode']} "
          f"returning={result['isReturning']} "
          f"knowledgeSoFar={len(result.get('knowledge', []))}")
    return result


def walk_to_building(session_id: str, building_id: str) -> None:
    print(f"  → /move to {building_id}")
    post(f"/api/agent/{session_id}/move", {"buildingId": building_id})


def visit_building(session_id: str, building_id: str) -> dict[str, Any]:
    result = post(f"/api/agent/{session_id}/visit-building", {"buildingId": building_id})
    gained = result.get("knowledgeGained")
    if gained:
        print(f"  📚 Learned: {gained}")
    return result


def main() -> int:
    try:
        session = connect()
    except Exception as e:
        print(f"✗ connect failed: {e}", file=sys.stderr)
        return 1

    session_id: str = session["sessionId"]

    # State the agent maintains client-side
    visited: set[str] = set()
    target_building: str | None = None
    perception_count = 0
    last_nearest_building_id: str | None = None

    print(f"→ Opening SSE stream /api/agent/{session_id}/events")

    try:
        for event_name, data in sse_stream(f"/api/agent/{session_id}/events"):
            if event_name == "ping":
                continue

            if event_name == "perception":
                perception_count += 1
                buildings = data.get("nearbyBuildings") or []
                if not buildings:
                    continue

                # Pick next unvisited building (nearest first)
                if target_building is None or target_building in visited:
                    next_target = next(
                        (b for b in buildings if b["buildingId"] not in visited),
                        None,
                    )
                    if next_target is None:
                        print(f"🎓 Visited all {len(visited)} buildings! Exiting.")
                        return 0
                    target_building = next_target["buildingId"]
                    walk_to_building(session_id, target_building)
                    time.sleep(0.2)

                # Check if arrived — nearest building == target AND distance < 80
                nearest = buildings[0]
                nearest_id = nearest["buildingId"]
                nearest_dist = nearest["distance"]

                if nearest_id == target_building and nearest_dist < 80:
                    try:
                        visit_building(session_id, target_building)
                        visited.add(target_building)
                        target_building = None
                    except Exception as e:
                        print(f"  ✗ visit failed: {e}")
                        visited.add(target_building)  # don't loop forever
                        target_building = None
                elif nearest_id != last_nearest_building_id:
                    print(f"  … nearest={nearest['label']} dist={nearest_dist}px "
                          f"target={target_building}")
                    last_nearest_building_id = nearest_id

            elif event_name == "combat_start":
                print(f"  ⚔️  entered combat: {data}")
            elif event_name == "combat_round":
                print(f"  💥 combat round: {data.get('round', {}).get('summary', '?')}")

    except KeyboardInterrupt:
        print("\n→ interrupted by user")
        return 0
    except Exception as e:
        print(f"✗ stream error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
