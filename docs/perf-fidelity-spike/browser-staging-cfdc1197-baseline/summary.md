# Browser Performance Run: staging-cfdc1197-baseline

Generated: 2026-06-07T11:42:16.409Z

- URL: https://staging.clawville.world/game?perf=1&cb=fidelity-baseline
- Ready: yes; textures ready: yes
- Quality tier: 4
- DPR: 0.65
- Render calls: 356
- Triangles: 700,488
- Visible buttons: 19
- Primitive building proxy meshes: 0
- Proxy-like named nodes: 0 (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: 37, total 23130ms, max 9958ms
- Resource transfer: 2.55 MB
- GLB/VRM resources: 68
- Screenshot: `game.png`

## Navigation

- TTFB: 58ms
- DOM interactive: 183ms
- DCL: 184ms
- Load: 459ms

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
| 13538ms | 9958ms | self |
| 4015ms | 6130ms | self |
| 10471ms | 2469ms | self |
| 24109ms | 1196ms | self |
| 2897ms | 426ms | self |
| 23599ms | 342ms | self |
| 3677ms | 336ms | self |
| 10231ms | 204ms | self |
| 1015ms | 170ms | self |
| 624ms | 167ms | self |

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
| `milady-chibi.vrm?v=2` | 300 B | 5.57 MB | 971ms |
| `eliza-chibi.vrm?v=2` | 300 B | 5.29 MB | 963ms |
| `quest-bounty-pavilion.glb?v=3` | 0 B | 2.11 MB | 432ms |
| `tekk.vrm` | 300 B | 1.95 MB | 162ms |
| `hermes-female.vrm` | 300 B | 1.62 MB | 146ms |
| `shisha-oasis.glb` | 0 B | 1.53 MB | 60ms |
| `chum-bucket-v2-opt1.glb?v=3` | 0 B | 1.52 MB | 42ms |
| `hermes-male.vrm` | 300 B | 1.28 MB | 140ms |
| `krusty-krab-v2-opt1.glb?v=3` | 0 B | 1.14 MB | 28ms |
| `squidward-house-opt1.glb?v=4` | 0 B | 1.06 MB | 57ms |
| `patricks-rock-v2-opt1.glb?v=4` | 0 B | 1012.1 KB | 51ms |
| `guide-rigged.glb` | 0 B | 926.6 KB | 12ms |
| `claw-arcade-exterior-opt1.glb?v=3` | 0 B | 785.5 KB | 43ms |
| `milady-official-5.vrm` | 300 B | 643.0 KB | 121ms |
| `lobster_plush.glb` | 553.3 KB | 556.8 KB | 406ms |
| `pineapple-house-opt1.glb?v=2` | 0 B | 541.3 KB | 16ms |
| `patty-building-opt1.glb?v=2` | 0 B | 494.5 KB | 21ms |
| `spongebob.glb` | 377.9 KB | 463.6 KB | 400ms |
| `bazaar-merchant-stand.glb?v=2` | 0 B | 420.5 KB | 43ms |
| `salty-spitoon-opt1.glb?v=2` | 0 B | 381.6 KB | 14ms |

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
