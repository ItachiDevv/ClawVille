# Browser Performance Run: local-texture-batch-resident-stream-3010

Generated: 2026-06-08T07:28:29.119Z

- URL: http://localhost:3010/game?perf=1&cb=local-texture-batch-resident-stream-3010
- Ready: yes; textures ready: yes
- Quality tier: 4
- DPR: 0.65
- Render calls: 2702
- Triangles: 632,195
- Visible buttons: 21
- Primitive building proxy meshes: 0
- Proxy-like named nodes: 0 (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: 27, total 20870ms, max 5069ms
- VRM loads captured: 13
- Texture upload: 179 textures via idle, 20552ms, max slice 9ms
- Resource transfer: 32.54 MB
- GLB/VRM resources: 68
- Screenshot: `game.png`

## Navigation

- TTFB: 425ms
- DOM interactive: 540ms
- DCL: 541ms
- Load: 826ms

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
| 4342ms | 5069ms | self |
| 12319ms | 3768ms | self |
| 16468ms | 3042ms | self |
| 9601ms | 2192ms | self |
| 20024ms | 2113ms | self |
| 22345ms | 1086ms | self |
| 38388ms | 681ms | self |
| 23665ms | 323ms | self |
| 24422ms | 276ms | self |
| 1707ms | 229ms | self |

## Slowest VRM Loads

| Asset | Total | Fetch wait | Parse | Normalise | Bytes | Meshes | Skinned |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eliza-chibi.vrm?v=2` | 20038ms | 35ms | 142ms | 2ms | 5.29 MB | 1 | 1 |
| `tekk.vrm` | 19788ms | 35ms | 71ms | 6ms | 1.95 MB | 1 | 1 |
| `hermes-male.vrm` | 19340ms | 35ms | 58ms | 7ms | 1.28 MB | 1 | 1 |
| `hermes-female.vrm` | 19160ms | 35ms | 1147ms | 6ms | 1.62 MB | 1 | 1 |
| `milady-official-6.vrm` | 17898ms | 35ms | 2326ms | 0ms | 216.9 KB | 7 | 7 |
| `milady-official-5.vrm` | 15450ms | 35ms | 66ms | 0ms | 643.0 KB | 8 | 8 |
| `milady-official-4.vrm` | 15275ms | 36ms | 28ms | 0ms | 285.1 KB | 8 | 8 |
| `milady-official-3.vrm` | 12156ms | 35ms | 38ms | 0ms | 234.0 KB | 7 | 7 |
| `milady-official-1.vrm` | 12010ms | 35ms | 29ms | 1ms | 236.6 KB | 12 | 12 |
| `milady-official-2.vrm` | 11868ms | 36ms | 3848ms | 0ms | 166.4 KB | 4 | 4 |
| `milady-official-8.vrm` | 7913ms | 36ms | 105ms | 2ms | 327.3 KB | 9 | 9 |
| `milady-official-7.vrm` | 7656ms | 34ms | 7619ms | 3ms | 281.9 KB | 6 | 6 |
| `milady-chibi.vrm?v=2` | 405ms | 0ms | 400ms | 2ms | 5.57 MB | 1 | 1 |

## Texture Upload Slices

- Mode: idle
- Textures: 179
- Duration: 20552ms
- Slices: 47
- Max slice: 9ms

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
| `milady-chibi.vrm?v=2` | 5.57 MB | 5.57 MB | 1207ms |
| `eliza-chibi.vrm?v=2` | 5.29 MB | 5.29 MB | 1120ms |
| `quest-bounty-pavilion.glb?v=3` | 1.72 MB | 2.11 MB | 840ms |
| `tekk.vrm` | 1.95 MB | 1.95 MB | 586ms |
| `hermes-female.vrm` | 1.62 MB | 1.62 MB | 492ms |
| `shisha-oasis.glb` | 879.8 KB | 1.53 MB | 634ms |
| `chum-bucket-v2-opt1.glb?v=3` | 1.42 MB | 1.52 MB | 301ms |
| `hermes-male.vrm` | 1.28 MB | 1.28 MB | 473ms |
| `krusty-krab-v2-opt1.glb?v=3` | 962.8 KB | 1.14 MB | 197ms |
| `squidward-house-opt1.glb?v=4` | 1015.4 KB | 1.06 MB | 320ms |
| `patricks-rock-v2-opt1.glb?v=4` | 927.9 KB | 1012.1 KB | 296ms |
| `guide-rigged.glb` | 539.5 KB | 926.6 KB | 57ms |
| `claw-arcade-exterior-opt1.glb?v=3` | 689.0 KB | 785.5 KB | 187ms |
| `milady-official-5.vrm` | 643.3 KB | 643.0 KB | 386ms |
| `lobster_plush.glb` | 553.3 KB | 556.8 KB | 51ms |
| `pineapple-house-opt1.glb?v=2` | 528.1 KB | 541.3 KB | 105ms |
| `patty-building-opt1.glb?v=2` | 327.2 KB | 494.5 KB | 80ms |
| `spongebob.glb` | 377.9 KB | 463.6 KB | 31ms |
| `bazaar-merchant-stand.glb?v=2` | 382.9 KB | 420.5 KB | 314ms |
| `salty-spitoon-opt1.glb?v=2` | 364.8 KB | 381.6 KB | 74ms |

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
