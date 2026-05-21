# Model Attribution

The following 3D models are used under CC-BY license. Full credit to their creators:

- **Fish Market Stall** by duckcracker02 (CC-BY)
  https://sketchfab.com/3d-models/hand-painted-fish-market-stall-cf2ed4d11385403d980fea31a0102093

- **Medieval Food Stall** by SpatialNeglect (CC-BY)
  https://sketchfab.com/3d-models/medieval-food-stall-7d9b2922dd0941dab820c4763078c789

- **Space Dome Showcase** by dylanheyes (CC-BY)
  https://sketchfab.com/3d-models/space-dome-showcase-5fda4e11a13e4b72bfe230edbd5bdbf9

- **The Krusty Krab (SpongeBob)** by Yanez Designs (CC-BY) — `krusty-krab.glb`
  https://sketchfab.com/3d-models/the-krusty-krab-spongebob-77eb7ac71cf34487a68394e826fb24d7

- **Squidward's House (SpongeBob)** by Yanez Designs (CC-BY) — `squidward-house.glb`
  https://sketchfab.com/3d-models/squidwards-house-spongebob-cf183eb8ce0a4ba59c5de662580bb1de

- **Patrick's House (SpongeBob)** by Yanez Designs (CC-BY) — `patricks-rock.glb`
  https://sketchfab.com/3d-models/patricks-house-spongebob-e903770349644943b400f8b72d2d3958

- **Sandy's Treedome (SpongeBob)** by landon141 (CC-BY) — `sandy-treedome.glb`
  https://sketchfab.com/3d-models/sandy-treedome-bf5893398ff3444ea4157682146ec5b7
  Decimated from 86 MB → 3.56 MB via gltf-transform optimize+simplify(0.4)+draco on 2026-04-29.

- **Sandy Cheeks (Mixamo rig)** by mustafatylan68 (CC-BY) — `characters/sandy.glb`
  https://sketchfab.com/3d-models/sandy-cheeks-mixamo-rig-9fda6cf3ae534385885ac27bb84e0bb8
  Mixamo-rigged with 1 idle clip (named `mixamo.com`); replaces the prior static
  Gusifer719 export which was authored lying-down (no T-pose). 1.2 MB.

## Phase 6 — Casino + Claw Arcade (added 2026-05-17)

- **Pyramid Casino** by tl0615 (CC-BY-4.0) — `casino/casino-exterior.glb` (used in-game as: Predictive Gaming Cove)
  https://sketchfab.com/3d-models/pyramid-casino-8ec6e308a328418db19dc9212962640c
  Neon Mayan step-pyramid casino exterior. 450 KB, 7,578 tris, 5 meshes.
  Origin offset from author (~(-1800, 166, 4540) Blender units) — recenter before placing in world.

- **Gameready Casino scene** by Katydid (Sketchfab Standard, commercial use verified by repo owner 2026-05-17) — `casino/casino-interior.glb`
  https://sketchfab.com/3d-models/gameready-casino-scene-685736a30da846b4ad7f2ddb3b9a56fc
  Casino interior. Optimized 32.2 MB → 4.2 MB via gltf-transform optimize+simplify(0.15, error=0.05)+draco+webp(1024).
  Tri count post-optimize: 211,575. Renders only in route-isolated casino scene (not world ring) — perf-budget headroom relies on isolation.

- **Casino (low-poly cartoon)** by Poly-Polygonal (CC-BY-4.0) — `casino/casino-interior-fallback.glb`
  https://sketchfab.com/3d-models/casino-5924b8057f5c498c8a4e8f6b31f43877
  Lightweight fallback casino interior. 58 KB, 449 tris, 10 meshes (Object_8/9 = slot machines, Object_4/5/6 = tables).
  Used if `casino-interior.glb` fails Iris Xe FPS gate in playtest.

- **Arcade City** by vanessalani (CC-BY-4.0) — `arcade/claw-arcade-exterior.glb`
  https://sketchfab.com/3d-models/arcade-city-2619e948be514311b234c4e55f91ed20
  12th-building exterior — domed building with ARCADE CITY signage and arched entrance. 4.2 MB, 2,473 tris.
  Interior added separately in Phase 6.3 (claw machine game).

- **Slot Machine Symbol Set** (ClawVille first-party, hand-drafted; third pass 2026-05-19) —
  `apps/web/public/assets/slot-symbols/s0.svg` … `s9.svg`
  Ten hand-drafted SVG reel symbols. Every symbol uses a heavy dark outline (`#0a1428`, stroke 6)
  + 3-stop linearGradient bevel + radialGradient highlight + drop-shadow ellipse for a "cast plastic"
  classic-slot read. All path data, gradients, masks authored by hand.

  **Pass history:**
  - First pass (14 SVGs) — rejected; only s1 (Anemones), s2 (Starfish), s3 (Pufferfish), and s7
    (Coral 7) read as recognizable Vegas symbols. Six SVGs deleted as unused.
  - Second pass (8 SVGs, 2026-05-18) — Pearl/Anemones/Starfish/Pufferfish low/mid + Bell/BAR/7/WILD high.
  - **Third pass (10 SVGs, 2026-05-19)** — Vegas-accurate ordering with 3-tier BAR added (modern
    5-reel convention: each tier evaluates independently, no "any BAR" mixed-tier rule). Anemones
    art moved from id 1 → id 0 (renamed Cherry); Pufferfish art moved from id 3 → id 2 (renamed
    Orange). New art authored for Lemon (id 1), Plum (id 3), BAR×2 (id 8), BAR×3 (id 9).

  Final 10-symbol set (id → asset file → description):
  - `s0.svg` — CHERRY (was Pearl/Anemones; uses crimson anemone art the user approved as cherries):
    pair of crimson anemones with pink tentacle tips on coral stems
  - `s1.svg` — LEMON (new third-pass art; replaces Starfish): oval citrus body with classic
    "nipple" tip on the side, cream→yellow→amber bevel, green leaf + stem at top
  - `s2.svg` — ORANGE (was Starfish/Pufferfish; uses round orange-puffer art the user approved
    as orange): round orange puffer with 16-spike halo
  - `s3.svg` — PLUM (new third-pass art; replaces Pufferfish in slot 3): round-oval plum with
    small heart-indent at top, lavender→purple→violet bevel, waxy-bloom ellipse, stem + green leaf
  - `s4.svg` — BELL (unchanged from pass-2): classic Vegas brass bell — dome, flared rim, hanging
    brass clapper, coral-tinted top loop for thin sea twist
  - `s5.svg` — BAR (unchanged; tier 1): red-top + gold-bottom rounded plaque with path-traced
    chunky "BAR" letters, gold inner border, 4 corner rivets
  - `s6.svg` — SEVEN (unchanged): chunky crimson "7" with coral branches + gold drop shadow
  - `s7.svg` — WILD (unchanged): steel-blue/cyan plaque with cyan glow halo, horizontal SHARK
    silhouette behind path-traced "WILD" letters
  - `s8.svg` — BAR×2 (new third-pass art; tier 2): two BAR plaques stacked at 0.8 scale,
    deeper red (#c0223a) bevel for tier distinction, identical text/rivet pattern as s5
  - `s9.svg` — BAR×3 (new third-pass art; tier 3): three BAR plaques stacked at 0.62 scale,
    deepest red (#a01828) bevel, identical text/rivet pattern
  No external license; covered by the ClawVille repo license.
