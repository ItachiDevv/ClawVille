# Browser Performance Run: local-resident-streaming-3010

Generated: 2026-06-08T07:23:14.997Z

- URL: http://localhost:3010/game?perf=1&cb=local-resident-streaming-3010
- Ready: no; textures ready: no
- Quality tier: 4
- DPR: 0.65
- Render calls: 1920
- Triangles: 679,667
- Visible buttons: 21
- Primitive building proxy meshes: 0
- Proxy-like named nodes: 0 (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: 80, total 25935ms, max 5649ms
- VRM loads captured: 13
- Texture upload: 179 textures via idle, -, max slice 5ms
- Resource transfer: 31.72 MB
- GLB/VRM resources: 60
- Screenshot: `game.png`

## Navigation

- TTFB: 615ms
- DOM interactive: 747ms
- DCL: 748ms
- Load: 1079ms

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
| 4667ms | 5649ms | self |
| 13133ms | 3376ms | self |
| 10550ms | 2361ms | self |
| 17418ms | 2225ms | self |
| 19897ms | 1993ms | self |
| 25946ms | 929ms | self |
| 58211ms | 861ms | self |
| 39456ms | 825ms | self |
| 53943ms | 730ms | self |
| 22777ms | 372ms | self |

## Slowest VRM Loads

| Asset | Total | Fetch wait | Parse | Normalise | Bytes | Meshes | Skinned |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eliza-chibi.vrm?v=2` | 18961ms | 53ms | 187ms | 2ms | 5.29 MB | 1 | 1 |
| `tekk.vrm` | 18659ms | 53ms | 488ms | 6ms | 1.95 MB | 1 | 1 |
| `hermes-male.vrm` | 18054ms | 53ms | 79ms | 3ms | 1.28 MB | 1 | 1 |
| `hermes-female.vrm` | 17862ms | 53ms | 67ms | 6ms | 1.62 MB | 1 | 1 |
| `milady-official-6.vrm` | 17433ms | 53ms | 30ms | 0ms | 216.9 KB | 7 | 7 |
| `milady-official-5.vrm` | 17299ms | 53ms | 2050ms | 0ms | 643.0 KB | 8 | 8 |
| `milady-official-4.vrm` | 15146ms | 53ms | 40ms | 1ms | 285.1 KB | 8 | 8 |
| `milady-official-3.vrm` | 12746ms | 53ms | 55ms | 0ms | 234.0 KB | 7 | 7 |
| `milady-official-1.vrm` | 12577ms | 53ms | 77ms | 1ms | 236.6 KB | 12 | 12 |
| `milady-official-2.vrm` | 12387ms | 53ms | 32ms | 0ms | 166.4 KB | 4 | 4 |
| `milady-official-8.vrm` | 12250ms | 54ms | 304ms | 3ms | 327.3 KB | 9 | 9 |
| `milady-official-7.vrm` | 8451ms | 52ms | 8394ms | 4ms | 281.9 KB | 6 | 6 |
| `milady-chibi.vrm?v=2` | 322ms | 0ms | 316ms | 3ms | 5.57 MB | 1 | 1 |

## Texture Upload Slices

- Mode: idle
- Textures: 179
- Duration: -
- Slices: 164
- Max slice: 5ms

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
| `milady-chibi.vrm?v=2` | 5.57 MB | 5.57 MB | 1171ms |
| `eliza-chibi.vrm?v=2` | 5.29 MB | 5.29 MB | 1079ms |
| `quest-bounty-pavilion.glb?v=3` | 1.72 MB | 2.11 MB | 763ms |
| `tekk.vrm` | 1.95 MB | 1.95 MB | 548ms |
| `hermes-female.vrm` | 1.62 MB | 1.62 MB | 477ms |
| `shisha-oasis.glb` | 879.8 KB | 1.53 MB | 636ms |
| `chum-bucket-v2-opt1.glb?v=3` | 1.42 MB | 1.52 MB | 268ms |
| `hermes-male.vrm` | 1.28 MB | 1.28 MB | 467ms |
| `krusty-krab-v2-opt1.glb?v=3` | 962.8 KB | 1.14 MB | 210ms |
| `squidward-house-opt1.glb?v=4` | 1015.4 KB | 1.06 MB | 313ms |
| `patricks-rock-v2-opt1.glb?v=4` | 927.9 KB | 1012.1 KB | 279ms |
| `guide-rigged.glb` | 539.5 KB | 926.6 KB | 58ms |
| `claw-arcade-exterior-opt1.glb?v=3` | 689.0 KB | 785.5 KB | 200ms |
| `milady-official-5.vrm` | 643.3 KB | 643.0 KB | 365ms |
| `lobster_plush.glb` | 553.3 KB | 556.8 KB | 50ms |
| `pineapple-house-opt1.glb?v=2` | 528.1 KB | 541.3 KB | 103ms |
| `patty-building-opt1.glb?v=2` | 327.2 KB | 494.5 KB | 78ms |
| `bazaar-merchant-stand.glb?v=2` | 382.9 KB | 420.5 KB | 293ms |
| `salty-spitoon-opt1.glb?v=2` | 364.8 KB | 381.6 KB | 72ms |
| `milady-official-8.vrm` | 327.5 KB | 327.3 KB | 365ms |

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
