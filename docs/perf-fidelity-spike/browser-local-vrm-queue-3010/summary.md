# Browser Performance Run: local-vrm-queue-3010

Generated: 2026-06-08T02:41:23.579Z

- URL: http://localhost:3010/game?perf=1&cb=local-vrm-queue-3010
- Ready: yes; textures ready: yes
- Quality tier: 4
- DPR: 0.65
- Render calls: 610
- Triangles: 359,666
- Visible buttons: 19
- Primitive building proxy meshes: 0
- Proxy-like named nodes: 0 (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: 31, total 19580ms, max 6249ms
- VRM loads captured: 12
- Texture upload: 215 textures via idle, 10830ms, max slice 11ms
- Resource transfer: 29.07 MB
- GLB/VRM resources: 68
- Screenshot: `game.png`

## Navigation

- TTFB: 359ms
- DOM interactive: 501ms
- DCL: 502ms
- Load: 765ms

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
| 4334ms | 6249ms | self |
| 13703ms | 3394ms | self |
| 10920ms | 2523ms | self |
| 17786ms | 1800ms | self |
| 19818ms | 1527ms | self |
| 25895ms | 1052ms | self |
| 2880ms | 320ms | self |
| 24642ms | 262ms | self |
| 10649ms | 234ms | self |
| 25510ms | 211ms | self |

## Slowest VRM Loads

| Asset | Total | Fetch wait | Parse | Normalise | Bytes | Meshes | Skinned |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eliza-chibi.vrm?v=2` | 18406ms | 77ms | 181ms | 4ms | 5.29 MB | 1 | 1 |
| `tekk.vrm` | 18044ms | 77ms | 161ms | 3ms | 1.95 MB | 1 | 1 |
| `hermes-male.vrm` | 17704ms | 77ms | 253ms | 3ms | 1.28 MB | 1 | 1 |
| `hermes-female.vrm` | 17322ms | 77ms | 66ms | 5ms | 1.62 MB | 1 | 1 |
| `milady-official-6.vrm` | 17142ms | 77ms | 1579ms | 0ms | 216.9 KB | 7 | 7 |
| `milady-official-5.vrm` | 15454ms | 77ms | 94ms | 1ms | 643.0 KB | 8 | 8 |
| `milady-official-4.vrm` | 13490ms | 77ms | 50ms | 0ms | 285.1 KB | 8 | 8 |
| `milady-official-3.vrm` | 13321ms | 77ms | 57ms | 0ms | 234.0 KB | 7 | 7 |
| `milady-official-1.vrm` | 13161ms | 77ms | 42ms | 1ms | 236.6 KB | 12 | 12 |
| `milady-official-2.vrm` | 12995ms | 78ms | 26ms | 0ms | 166.4 KB | 4 | 4 |
| `milady-official-8.vrm` | 12859ms | 78ms | 3420ms | 2ms | 327.3 KB | 9 | 9 |
| `milady-official-7.vrm` | 9334ms | 76ms | 9255ms | 3ms | 281.9 KB | 6 | 6 |

## Texture Upload Slices

- Mode: idle
- Textures: 215
- Duration: 10830ms
- Slices: 18
- Max slice: 11ms

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
| `milady-chibi.vrm?v=2` | 5.57 MB | 5.57 MB | 1276ms |
| `eliza-chibi.vrm?v=2` | 5.29 MB | 5.29 MB | 1013ms |
| `quest-bounty-pavilion.glb?v=3` | 1.72 MB | 2.11 MB | 628ms |
| `tekk.vrm` | 1.95 MB | 1.95 MB | 458ms |
| `hermes-female.vrm` | 1.62 MB | 1.62 MB | 389ms |
| `shisha-oasis.glb` | 879.8 KB | 1.53 MB | 491ms |
| `chum-bucket-v2-opt1.glb?v=3` | 1.42 MB | 1.52 MB | 252ms |
| `hermes-male.vrm` | 1.28 MB | 1.28 MB | 384ms |
| `krusty-krab-v2-opt1.glb?v=3` | 962.8 KB | 1.14 MB | 198ms |
| `squidward-house-opt1.glb?v=4` | 1015.4 KB | 1.06 MB | 282ms |
| `patricks-rock-v2-opt1.glb?v=4` | 927.9 KB | 1012.1 KB | 238ms |
| `guide-rigged.glb` | 0 B | 926.6 KB | 754ms |
| `claw-arcade-exterior-opt1.glb?v=3` | 689.0 KB | 785.5 KB | 207ms |
| `milady-official-5.vrm` | 643.3 KB | 643.0 KB | 324ms |
| `lobster_plush.glb` | 0 B | 556.8 KB | 212ms |
| `pineapple-house-opt1.glb?v=2` | 528.1 KB | 541.3 KB | 112ms |
| `patty-building-opt1.glb?v=2` | 327.2 KB | 494.5 KB | 87ms |
| `spongebob.glb` | 0 B | 463.6 KB | 237ms |
| `bazaar-merchant-stand.glb?v=2` | 382.9 KB | 420.5 KB | 279ms |
| `salty-spitoon-opt1.glb?v=2` | 364.8 KB | 381.6 KB | 83ms |

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
