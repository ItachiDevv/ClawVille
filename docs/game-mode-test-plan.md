# ClawVille Game Mode Test Plan

## Overview

ClawVille has 4 game modes controlled by `controlMode` in the Zustand `game.ts` store. This document defines the test procedure and expected behavior for each mode.

## Test Environment

- **URL**: `https://clawville.world/game`
- **Desktop**: Chrome DevTools standard viewport (~1176x1010)
- **Mobile**: Chrome DevTools device toggle → iPhone 14 Pro (393x852) or similar
- **Prerequisite**: Logged-in user with a created pet (e.g. TokenTestBot)

---

## Mode 1: Explore (No Agent)

**Toggle position**: Left button "Explore" (active cyan)

### Expected Behavior
| Feature | Expected | Status |
|---------|----------|--------|
| Lobster character visible | NO — pure spectator | |
| WASD keys | Move camera (WASDCameraController) | |
| Arrow keys | Orbit camera angle | |
| E key near building | Nothing happens — no building entry | |
| Location HUD | Never appears (nearLocation always null) | |
| Pet status bar | Hidden | |
| Pet chat bar | Hidden | |
| Click-to-move dots | Not rendered (ClickToMove hidden) | |
| Mobile: left joystick | Hidden (camera-only) | |
| Mobile: right joystick | Visible (camera orbit) | |
| Mobile: E button | Hidden | |
| Minimap | Visible, no player dot | |
| Sidebar menu | Visible | |
| FPS | Stable (70+ on desktop) | |

### Test Steps (Desktop)
1. Load `/game` — dismiss daily login if shown
2. Verify "Explore" toggle is active (cyan highlight)
3. Verify NO lobster character in the 3D scene
4. Press WASD — confirm camera pans, no character moves
5. Press E near a building — confirm nothing happens
6. Verify bottom-left has NO pet status bar or pet chat bar

### Test Steps (Mobile)
1. Toggle Chrome DevTools to mobile viewport
2. Verify no left joystick zone appears
3. Verify right joystick (camera orbit) works
4. Verify no "E" button appears

---

## Mode 2: NPC Mode (No Agent)

**Toggle position**: Right button "NPC Mode" (active cyan)

### Expected Behavior
| Feature | Expected | Status |
|---------|----------|--------|
| NPC character spawned | YES — blue lobster "You" at world center (1280, 1280) | |
| Camera | FPSFollowCamera follows the NPC | |
| WASD keys | Move the NPC (camera-relative) | |
| E key near building | Enters building (opens chat panel) | |
| Escape inside building | Exits building | |
| Location HUD | Shows when NPC is inside building zone | |
| Pet status bar | Visible (user has a pet) | |
| Pet chat bar | Visible | |
| NPC label | Shows "You" above the player NPC | |
| Proximity detection | Works every frame (even when idle) | |
| Mobile: left joystick | Visible — moves NPC | |
| Mobile: E button | Visible when near building | |
| Switching back to Explore | NPC removed, nearLocation cleared | |

### Test Steps (Desktop)
1. Click "NPC Mode" toggle
2. Verify camera teleports to world center
3. Verify a lobster NPC labeled "You" is visible
4. Press WASD — confirm NPC moves, camera follows
5. Navigate toward a building — verify Location HUD appears
6. Press E — verify building chat panel opens
7. Press Escape — verify exits building
8. Toggle back to "Explore" — verify NPC disappears

### Test Steps (Mobile)
1. Toggle to NPC Mode
2. Verify left joystick appears
3. Push joystick — NPC moves in joystick direction
4. Move near building — E button appears
5. Tap E — enters building

---

## Mode 3: Control (Agent Connected)

**Toggle position**: Left button "Play" (active cyan) — only after connecting an OpenClaw agent

### Expected Behavior
| Feature | Expected | Status |
|---------|----------|--------|
| Player lobster visible | YES — pet lobster with user's color tint | |
| Camera | FPSFollowCamera follows pet | |
| WASD keys | Move pet (screen-relative) | |
| Joystick | Move pet (screen-relative) | |
| E key near building | Enters building | |
| Click-to-move | Active — click ground to pathfind | |
| Pet status bar | Visible | |
| Pet chat bar | Visible | |
| All game UI | Visible (shop, inventory, quests) | |

### Test Steps
1. Click "OpenClaw" in sidebar → connect an agent
2. Verify toggle switches to "Play" / "Autonomous"
3. Verify pet lobster appears in 3D scene
4. Press WASD — pet moves, camera follows
5. Click on ground — path dots appear, pet walks to destination
6. Navigate to building, press E — enters building

---

## Mode 4: Autonomous (Agent Connected)

**Toggle position**: Right button "Autonomous" (active cyan)

### Expected Behavior
| Feature | Expected | Status |
|---------|----------|--------|
| Player lobster visible | YES — same pet, but autonomy engine drives it | |
| Camera | FPSFollowCamera follows pet | |
| WASD keys | Disabled (autonomy drives movement) | |
| Pet navigates independently | YES — visits buildings, learns skills | |
| Autonomy HUD | Visible (shows agent goal/status) | |
| E key | Disabled (autonomy handles building entry) | |
| Escape key | Disabled (autonomy handles building exit) | |

### Test Steps
1. With agent connected, toggle to "Autonomous"
2. Verify pet begins moving on its own
3. Verify Autonomy HUD appears with agent status
4. Verify WASD has no effect on pet movement
5. Watch pet navigate to a building and enter it
6. Toggle back to "Play" — verify manual control returns

---

## Cross-Mode Tests

| Test | Expected |
|------|----------|
| Explore → NPC Mode | NPC spawns at center, camera teleports |
| NPC Mode → Explore | NPC removed, camera stays, nearLocation cleared |
| Connect agent while in Explore | Switches to Play mode, pet appears |
| Connect agent while in NPC | Switches to Play mode, NPC removed, pet appears |
| Disconnect agent in Play | Switches to Explore mode, pet hidden |
| Disconnect agent in Autonomous | Autonomy stops, switches to Explore |

---

## Known Issues / Bugs Fixed

1. **Pet UI in Explore mode** — PetStatusBar/PetChatBar were visible in explore mode. Fixed: gated on `controlMode !== 'explore'` in `game/page.tsx`.
2. **NPC mode possessed wandering NPC** — Was hijacking first wandering NPC instead of spawning a dedicated one. Fixed: `spawnPlayerNpc()` creates `__player-npc__` at (1280, 1280).
3. **Proximity check missed when idle** — NPC controller only ran proximity check during movement. Fixed: moved check before early return.
4. **Stale nearLocation after mode switch** — Switching from NPC to Explore left nearLocation set. Fixed: clear on explore mode entry.
5. **isSpectator wrong for NPC mode** — Was true for both explore and NPC. Fixed: only true for explore.
