# Browser Performance Run: staging-recheck-20260608

Generated: 2026-06-08T02:11:27.308Z

- URL: https://staging.clawville.world/game?perf=1&cb=staging-recheck-20260608
- Ready: no; textures ready: no
- Quality tier: 3
- DPR: 0.65
- Render calls: 12
- Triangles: 766,471
- Visible buttons: 19
- Primitive building proxy meshes: 0
- Proxy-like named nodes: 0 (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: 18, total 17219ms, max 4417ms
- VRM loads captured: 0
- Texture upload: not captured
- Resource transfer: 29.91 MB
- GLB/VRM resources: 62
- Screenshot: `game.png`

## Navigation

- TTFB: 62ms
- DOM interactive: 334ms
- DCL: 334ms
- Load: 617ms

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
| 7654ms | 4417ms | self |
| 12387ms | 4268ms | self |
| 4406ms | 3186ms | self |
| 16749ms | 3094ms | self |
| 1099ms | 383ms | self |
| 3186ms | 379ms | self |
| 4054ms | 351ms | self |
| 791ms | 178ms | self |
| 3894ms | 159ms | self |
| 467ms | 141ms | self |

## Slowest VRM Loads

| Asset | Total | Fetch wait | Parse | Normalise | Bytes | Meshes | Skinned |
|---|---:|---:|---:|---:|---:|---:|---:|
| - | - | - | - | - | - | - | - |

## Texture Upload Slices

- Not captured

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
| `milady-chibi.vrm?v=2` | 4.53 MB | 5.57 MB | 1050ms |
| `eliza-chibi.vrm?v=2` | 4.43 MB | 5.29 MB | 877ms |
| `quest-bounty-pavilion.glb?v=3` | 1.72 MB | 2.11 MB | 916ms |
| `tekk.vrm` | 1.87 MB | 1.95 MB | 551ms |
| `hermes-female.vrm` | 1.55 MB | 1.62 MB | 529ms |
| `shisha-oasis.glb` | 879.8 KB | 1.53 MB | 889ms |
| `chum-bucket-v2-opt1.glb?v=3` | 1.42 MB | 1.52 MB | 915ms |
| `hermes-male.vrm` | 1.20 MB | 1.28 MB | 487ms |
| `krusty-krab-v2-opt1.glb?v=3` | 962.8 KB | 1.14 MB | 894ms |
| `squidward-house-opt1.glb?v=4` | 1015.4 KB | 1.06 MB | 891ms |
| `patricks-rock-v2-opt1.glb?v=4` | 927.9 KB | 1012.1 KB | 795ms |
| `guide-rigged.glb` | 539.5 KB | 926.6 KB | 172ms |
| `claw-arcade-exterior-opt1.glb?v=3` | 689.0 KB | 785.5 KB | 687ms |
| `milady-official-5.vrm` | 613.2 KB | 643.0 KB | 341ms |
| `lobster_plush.glb` | 553.3 KB | 556.8 KB | 198ms |
| `pineapple-house-opt1.glb?v=2` | 528.1 KB | 541.3 KB | 583ms |
| `patty-building-opt1.glb?v=2` | 327.2 KB | 494.5 KB | 555ms |
| `spongebob.glb` | 377.9 KB | 463.6 KB | 196ms |
| `bazaar-merchant-stand.glb?v=2` | 382.9 KB | 420.5 KB | 556ms |
| `salty-spitoon-opt1.glb?v=2` | 364.8 KB | 381.6 KB | 544ms |

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
