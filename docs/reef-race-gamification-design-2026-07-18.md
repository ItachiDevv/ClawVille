# Reef Race Gamification — Design Brief (Rounds 9–11)

**Date:** 2026-07-18 · **Author:** Fable (plan) → Codex (implement) → Fable (review)
**Trigger:** founder round-8 retest verdict: "physics really good, riding smooth — but not gamified enough, not competitive enough, items don't work, boost pads do nothing, drift charges on plain turning, no obstacles, I can win by holding forward."

---

## 0. What the retest actually revealed — two bugs are HIDING the gamification that already exists

### B1 — CRITICAL input-contract bug: the item system is fully built server-side but unreachable from the keyboard

The client and server disagree about what the wire action bits mean:

| bit | Client sends (`useActivityInput.ts:47-55, 364-376`) | Server reads (`reef-race-config.ts:521-524`, spline sim `:1133-1143`) |
|---|---|---|
| 0 | `ACTION_BIT_BOOST` — **Space** (held + one-shot) | `ACTION_BIT_POWERUP_0` — **use item slot 0** |
| 1 | `ACTION_BIT_USE_POWERUP` — **Q** (one-shot) | `ACTION_BIT_POWERUP_1` — **use item slot 1** |
| 2 | `ACTION_BIT_JUMP` — Shift | jump ✅ (matches) |

Pickups fill the **first empty slot** (`reef-race-spline-sim.ts:1940`), i.e. slot 0 first. Consequences:

- **Q — the documented item key — fires slot 1, which is empty unless you're carrying TWO items.** For a player with one item, Q does nothing. This is the founder's "running into item boxes does nothing / items still don't work."
- **Space — which the round-8 lobby instructions literally label "Boost when held with input" (`reef-race-instructions.tsx:108`) — actually consumes item slot 0.** A player following the instructions holds Space, and every item is silently eaten the tick it's collected. There is **no** hold-to-boost verb on the server at all — the label describes a mechanic that doesn't exist.
- The HUD contradicts the instructions: it labels slot 0 `SPACE` and slot 1 `Q` (`reef-race-hud.tsx:552`), which is wire-accurate but design-wrong.

So the whole 6-item catalog — turbo bubble, bubble shield, ink slick, seeker jelly, tide wave, whirlpool, **including Mario-Kart-style placement-weighted rubber-band item tables** (`PLACEMENT_ITEM_TABLE`, leaders get defensive, last place gets aggressive) — is implemented and tested server-side (`resolvePowerUpUses`, shields resolve before offense, Codex-audited) and **has effectively never been experienced by the founder**.

### B2 — Boost pads work server-side; the game never TELLS you

`applyBoostPad` (spline sim `:1913`) gives an instant **+416 wu/s** along-heading kick (32% of cap, clamped 1.85×) plus a **+30% speed-cap raise for 1.5s**. The math is real. But: the lap is ~88,000 wu, the chase camera keeps constant distance, and there is no FOV change, no speed-line VFX, no camera shake, no audio pitch ramp, no spray burst. A 1.5s +30% surge nets ~3 kart-lengths on a track this size — **numerically meaningful, perceptually invisible**. Mario Kart's pads feel massive because of FOV punch + FX, not because of the numbers. This is a game-feel gap, not a physics gap. (The toast saying "boost" while nothing appears to change is the exact "it lies to me" experience the founder described.)

### B3 — "Drift" charges from ANY sustained turn — founder is right that it makes no sense

v2 retired the drift button (bit 2 → jump) and replaced it with a passive **carve mini-turbo**: any sustained ≥ ~60°/s heading change at speed charges a meter (tier 1 @ 480ms → +22%/0.9s, tier 2 @ 1.1s → +38%/1.3s, fires on carve-break, 600ms cooldown). On a broad-radius ring (min corner radius 2,156 wu — the wide river geometrically cannot have hairpins, `track-layout.ts:25-36`), **normal steering is always above the charge threshold** → everyone gets free periodic boosts for just driving. Zero commitment, zero risk, zero skill expression. This, plus B1/B2, is why "everyone ends up the same skill level."

**Conclusion:** before adding ANY new mechanics, Round 9 must (1) fix the input contract, (2) ship a boost game-feel kit, (3) convert the passive carve-charge into a committed drift. That alone turns on the ~40% of the game that's already built but invisible.

---

## 1. Design thesis

We will not out-polish Mario Kart on kart fundamentals. We CAN own the **surf fantasy**: waves, currents, tides, and sea creatures are mechanics MK structurally doesn't have. Direction:

1. **Legibility first** — every speed change must be felt (camera/FX/audio), every item hit must identify attacker and victim.
2. **Skill = commitment under risk** — drift you must hold and can overcook; wave faces you must time; hazard lines that are faster but punishable. Holding forward must be the SLOWEST viable strategy.
3. **Variance = seeded events, not dice** — per-race tide/wave/obstacle seeds so no two races are identical, but every element is telegraphed and counterplayable.
4. **Rubber-band drama** — already built (placement item tables); surface it, don't rebuild it.

Grading axes used below: skill expression · counterplay · legibility · sea-theme fit · implementation cost.

---

## 2. Round 9 — "turn the game on" (fix + feel; no new sim mechanics)

### 9.1 Input contract fix (P0, server + client + docs, small)
- **Q / click / mobile-B = use item slot 0.** On use, slot 1 auto-promotes to slot 0 (single USE key, MK-style; keep the 2-slot inventory as "held + queued").
- **Space is freed** (reserved for drift in Round 10; interim: Space = jump alias so the key isn't dead, Shift stays).
- Server: replace the two-bit slot addressing with one `ACTION_BIT_USE_ITEM` → always slot 0 + promote. Client hook, HUD labels, lobby + countdown instructions, mobile button mapping — **same diff**.
- **PARITY (E5):** connected/hosted agents send raw `actionBits` — this is a wire-semantic change → `PROTOCOL_VERSION` bump + protocol manual + tools.json update in the same diff. Bots: update bot intent builder if it uses item bits.
- Regression test: collect 1 item → press USE → slot-0 item consumed; collect 2 → USE ×2 → both fire in order.

### 9.2 Boost game-feel kit (P0, client-only, medium)
One shared **SpeedSurge** hook fired by: pad hit, mini-turbo/drift release, turbo bubble, launch boost, slipstream engage:
- FOV punch (+10–14°, ease-out ~0.7s) + slight camera pullback; subtle shake on pad hit.
- Radial speed-lines/streak overlay scaled to surge magnitude; water spray burst off the board tail.
- Audio: pitch-ramped whoosh layered per surge tier (Meshy/ElevenLabs asset pass later; placeholder synth ok).
- HUD speedometer that visibly climbs past its normal ceiling into a colored "surge" band.
- Iris-Xe budget: overlay + FOV are near-free; particles use the existing burst pools (no new per-frame allocs, no `InstancedMesh+ShaderMaterial`).

### 9.3 Item legibility pass (P0.5, client, medium)
Items currently resolve as toasts + numbers. Give each an in-world read (existing FX pools, no new material systems):
- **Seeker jelly:** homing jellyfish projectile mesh + trail; victim gets a sting flash + tentacle screen-edge vignette.
- **Ink slick:** persistent dark patch on the water where it lands + ink splat screen overlay on victims.
- **Tide wave:** expanding ring wavefront from the caster.
- **Whirlpool:** rendered vortex at the anchor point (it PULLS rivals — make the pull visible).
- **Bubble shield:** translucent bubble around the kart while active.
- **Turbo bubble:** trail + SpeedSurge.
- Attacker feedback: "HIT — <name>" micro-toast; victim feedback: "<item> from <name>".

**Round 9 exit test:** a new player, told nothing, collects a box, sees the slot fill, presses Q, sees the item DO something visible, and feels every boost pad. Founder retest should register pads as "pops."

---

## 3. Round 10 — drift becomes THE skill verb (server + client, medium-large)

Replace the passive carve mini-turbo with **committed drift** (this is the founder's "drifting charges on turning doesn't make sense" fix):

- **Tap Space** = hop. **Hold Space + steer** = drift: the board breaks loose (visible slide angle + carve spray arc), steering gets the MK-style angular bias (constant exists: `DRIFT_ANGULAR_BIAS_RAD`, 15°), and the charge meter builds **only while drifting** — reuse the existing tier ticks/mults and the carve-sign anti-farm reset (counter-steer flip zeroes the charge).
- **Release** = tiered boost through SpeedSurge (tier 1 +22%/0.9s, tier 2 +38%/1.3s to start; tune after playtest).
- **Cost/risk:** while drifting, grip drops (wider line, ~-8% forward speed) — overcooking sends you off-line into the slow shoulder water or a hazard. Straight-line players never earn turbos.
- **Passive carve-charge is REMOVED** in the same diff (one boost economy, no double-dipping).
- Spark legibility: wake color tiers (blue → orange), audio crackle tier-up cue, HUD meter.
- Bots: give mid/high-skill bots drift usage on the broad corners so humans see the mechanic modeled.
- Anti-cheat: boost still folds into the existing positive-stack cap (1.85× ceiling unchanged, validators untouched).

### 3.1 Track v7 — MORE turns, SHARPER turns (founder correction, 2026-07-18)

**The earlier "wide river geometrically can't have sharp corners" claim was wrong as a design statement** — it only holds at the current corridor width, which is itself an authoring choice. The v6 numbers (`track-layout.ts` header): half-width sweep **1,144–1,610 wu** → water surface 2,289–3,219 wu ≈ **26 kart-diameters wide at the NARROWEST point** — proportionally far wider than Mario Kart (~6–10 karts). The only hard constraint is wall-clamp: `R − hw > carve floor (~500 wu at cap 1300)`. Consequences:

- **Narrow the technical sections to MK-like proportions (hw 400–700)** → sharp corners of **R ≈ 900–1,200** become legal (vs today's min 2,156, which was just the wavy-circle harmonics choice).
- **More curvature reversals are trivially authorable** (v6 has 30; nothing blocks 40+ with mixed sharp/broad rhythm).
- v7 plan: keep the broad-sweep surf character on 2–3 segments; add **2 technical zones** (an S-bend chicane cluster + one near-hairpin at pinched width); re-run the verification harness (`ring-final.ts` / `width-scan.ts` pattern) to prove carve margin > floor at every t; re-derive segment-time floors + lap budget for the new arc.
- Optional pairing: **brake-to-tighten steering** (speed-sensitive turn rate) lowers the carve floor further and adds braking as a skill verb — lands naturally next to drift.

Drift (above) and track v7 ship together: drift needs corners worth committing to.

---

## 4. Rounds 11–12 — variance, obstacles, waves (the identity layer; server + client, large)

### 4.0 PREREQUISITE — water physics v2 + riding smoothness round 2 (founder, 2026-07-18)

If waves are going to carry the game's identity, the water itself has to earn it first:

- **Riding smoothness round 2.** The last smoothing pass was good but not identity-grade — another dedicated tuning round (free-drive sandbox loop: damping, wave-conform pose, heading response latency, camera glue) before the wave layer ships. Founder verdict, verbatim intent: "smooth, but not smooth enough to be the core of our identity."
- **Actual competitive waves, not bumps.** Today's moving water gives waves to go *over*, not waves to *play*. Needed: **curling/breaking waves at the track edges** (visible barrels/whitecaps) and a rideable **wave-face model** — a surface where position ON the wave (face vs crest vs behind) changes your speed, so wave positioning is a competitive read. Render side can borrow spectral-ocean techniques (choppy displacement, Jacobian whitecaps) but must stay track-local + LOD'd inside the Iris-Xe budget — not a full FFT ocean.
- **Rule E3 binds:** this is shader/3D work → continuous Claude↔Codex collaboration with the `3da` specialist, browser-verified every iteration.

Rolling wave events (4.1) ship only on top of this foundation.

### 4.1 Rolling wave events — the signature mechanic (MK can't do this)
Every 25–40s (seeded per race) a **wave front sweeps one track sector**: telegraphed ~3s ahead (horizon swell + minimap arc + rising audio). Riding its face while aligned = a long sustained surge (the best speed source in the game); caught side-on/behind = tumble + slow. Positioning FOR the next wave becomes the strategic layer between item fights.

### 4.2 Obstacles (the "I can go straight the whole race" fix)
Seeded per race from a hand-authored pool so lines change race-to-race, all jumpable or dodgeable:
- **Kelp clumps** — slow zone on contact (reuse hazard-slow plumbing from the ellipse phase-2 code).
- **Urchin balls** — spin-out on hit, jumpable (jump finally gets a defensive purpose).
- **Surfacing sea creature** — a turtle/whale crosses a lane on a timer, shadow + splash telegraph.
- **Driftwood** — low floating log; jump over or eat a bump.

### 4.3 Rip-current lanes
Visible fast-water ribbons placed OFF the racing line: free speed if you take the longer/riskier line — a real line-choice decision on every lap (renders as streaked current).

### 4.4 Ramps → trick system
6 ramps already launch you (`buildSplineRamps` — lagoon/kelp/shipwreck/canyon). Add: **directional tap while airborne = trick animation; clean landing = mini SpeedSurge**. Suddenly ramps are worth aiming for and air time is gameplay (MK trick-boost analog, surf-flavored).

### 4.5 New items (each with counterplay; extend `PLACEMENT_ITEM_TABLE`)
- **Pufferfish mine** — drop-behind, arms after 1s, spin-out on contact; jumpable, shield-blocked.
- **Bubble beam** — short-range forward shot; first rival hit is "bubbled" (floats up, no control ~1.5s).
- **Remora rocket** — last-place-only autopilot surge (~4s at hard cap) — the Bullet-Bill catchup beat.
- **Current swap** — legendary: swap positions with the racer directly ahead; loud telegraph so the victim gets a dodge window (jump breaks the lock).
- **Box variants:** standard, **double box** (fills both slots), **gamble box** (rainbow shimmer: legendary or a self-slow dud).

### 4.6 Race drama (cheap, sprinkle into any round)
- FINAL LAP banner + item-table aggression shift + music layer.
- Overtake ticker ("▲ P2") + rival proximity arrows; photo-finish slow-mo; post-race highlight card ("Biggest comeback", "Most items landed").

---

## 5. Already built — do NOT rebuild (harvest instead)

| System | Where | Status |
|---|---|---|
| 6-item catalog + effects (shield-first resolution) | spline sim `resolvePowerUpUses` + `apply*` | LIVE server-side, blocked by B1 |
| Placement rubber-band item tables | `PLACEMENT_ITEM_TABLE` (config `:782`) | LIVE at collect time |
| Slipstream (+20%) | spline sim (`slipAdd`) | LIVE, invisible (needs FX) |
| Boost pads ×4 / ramps ×6 | `buildSplineBoostPads/Ramps` + render `.tsx` | LIVE, feel-gap (B2) |
| Jump + airborne gating (pads/ramps ignore airborne) | spline sim | LIVE |
| Launch boost / stall (start timing) | spline sim | LIVE |
| Drift sparks/bias/tiers constants | config Phase-1 block | Legacy-ellipse only — harvest for Round-10 drift |
| Apex bonus/penalty, hazard patches, boost ribbons | config Phase-2 block | Legacy-ellipse only — harvest hazard plumbing for 4.2 |
| Anti-cheat validators + 1.85× kinetic cap | config + sim | LIVE — all new boosts must fold into the same stack |

---

## 6. Obligations checklist (every round)
- **E5 parity:** agents race via the same actionBits/WS surface — any wire or verb change ⇒ `PROTOCOL_VERSION` bump + protocol manual + PARITY note in the commit body.
- **Three-surface sync** on flow changes: Nori `knowledge[]` + connection SKILL.md + hosted `createMemory()`.
- `GameFeatures.md` §19 same-diff; `3dStructure.md` for scene/FX budget changes.
- Iris-Xe floor: FX via existing pools; no drei Text/Billboard; prod-bundle verify before staging push.
- Workflow: Fable plans (this doc) → **Codex implements** → Fable reviews → founder signs off on the live game.

## 7. Proposed build order (revised 2026-07-18 after founder corrections)

| Round | Contents | Size |
|---|---|---|
| **9** | B1 input fix (+PROTOCOL bump) + SpeedSurge feel kit + minimal item visibility | S+M — highest value-per-line right now; Codex dispatched 2026-07-18 |
| **10** | **Track v7** (more turns, 2 technical zones at pinched width, sharper radii, optional brake-to-tighten) + **committed drift** (replaces carve-charge) + bot drift | M |
| **11** | **Water physics v2** — curling edge waves, rideable wave-face model, riding smoothness round 2 (E3 collab: Codex + 3da, browser-verified per iteration) | M–L |
| **12** | Rolling wave events + obstacles + rip currents + ramp tricks + 2–4 new items + full item legibility + drama layer | L (splittable) |
