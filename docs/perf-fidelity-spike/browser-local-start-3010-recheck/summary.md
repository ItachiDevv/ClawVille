# Browser Performance Run: local-start-3010-recheck

Generated: 2026-06-08T02:16:40.014Z

- URL: http://localhost:3010/game?perf=1&cb=local-start-3010-recheck
- Ready: no; textures ready: no
- Quality tier: 4
- DPR: 0.65
- Render calls: 26
- Triangles: 622,331
- Visible buttons: 19
- Primitive building proxy meshes: 0
- Proxy-like named nodes: 0 (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: 24, total 30505ms, max 8171ms
- VRM loads captured: 12
- Texture upload: 215 textures via idle, -, max slice 11ms
- Resource transfer: 32.54 MB
- GLB/VRM resources: 68
- Screenshot: `game.png`

## Navigation

- TTFB: 543ms
- DOM interactive: 644ms
- DCL: 644ms
- Load: 919ms

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
| 4506ms | 8171ms | self |
| 26852ms | 6041ms | self |
| 17618ms | 5097ms | self |
| 13174ms | 3827ms | self |
| 22800ms | 3583ms | self |
| 32936ms | 1275ms | self |
| 4122ms | 383ms | self |
| 12778ms | 336ms | self |
| 2745ms | 294ms | self |
| 1563ms | 210ms | self |

## Slowest VRM Loads

| Asset | Total | Fetch wait | Parse | Normalise | Bytes | Meshes | Skinned |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eliza-chibi.vrm?v=2` | 13361ms | 114ms | 13241ms | 3ms | 5.29 MB | 1 | 1 |
| `milady-official-5.vrm` | 13335ms | 106ms | 13229ms | 1ms | 643.0 KB | 8 | 8 |
| `tekk.vrm` | 13327ms | 112ms | 13211ms | 4ms | 1.95 MB | 1 | 1 |
| `milady-official-1.vrm` | 13296ms | 104ms | 13192ms | 1ms | 236.6 KB | 12 | 12 |
| `hermes-female.vrm` | 13271ms | 108ms | 13159ms | 4ms | 1.62 MB | 1 | 1 |
| `milady-official-4.vrm` | 13251ms | 105ms | 13145ms | 1ms | 285.1 KB | 8 | 8 |
| `milady-official-6.vrm` | 13243ms | 106ms | 13135ms | 1ms | 216.9 KB | 7 | 7 |
| `milady-official-8.vrm` | 13229ms | 102ms | 13127ms | 1ms | 327.3 KB | 9 | 9 |
| `milady-official-3.vrm` | 13174ms | 104ms | 13070ms | 1ms | 234.0 KB | 7 | 7 |
| `hermes-male.vrm` | 13127ms | 110ms | 12994ms | 22ms | 1.28 MB | 1 | 1 |
| `milady-official-2.vrm` | 13075ms | 103ms | 12972ms | 1ms | 166.4 KB | 4 | 4 |
| `milady-official-7.vrm` | 13068ms | 99ms | 12965ms | 4ms | 281.9 KB | 6 | 6 |

## Texture Upload Slices

- Mode: idle
- Textures: 215
- Duration: -
- Slices: 6
- Max slice: 11ms

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
| `milady-chibi.vrm?v=2` | 5.57 MB | 5.57 MB | 1212ms |
| `eliza-chibi.vrm?v=2` | 5.29 MB | 5.29 MB | 943ms |
| `quest-bounty-pavilion.glb?v=3` | 1.72 MB | 2.11 MB | 719ms |
| `tekk.vrm` | 1.95 MB | 1.95 MB | 548ms |
| `hermes-female.vrm` | 1.62 MB | 1.62 MB | 471ms |
| `shisha-oasis.glb` | 879.8 KB | 1.53 MB | 579ms |
| `chum-bucket-v2-opt1.glb?v=3` | 1.42 MB | 1.52 MB | 301ms |
| `hermes-male.vrm` | 1.28 MB | 1.28 MB | 455ms |
| `krusty-krab-v2-opt1.glb?v=3` | 962.8 KB | 1.14 MB | 210ms |
| `squidward-house-opt1.glb?v=4` | 1015.4 KB | 1.06 MB | 323ms |
| `patricks-rock-v2-opt1.glb?v=4` | 927.9 KB | 1012.1 KB | 285ms |
| `guide-rigged.glb` | 539.5 KB | 926.6 KB | 92ms |
| `claw-arcade-exterior-opt1.glb?v=3` | 689.0 KB | 785.5 KB | 219ms |
| `milady-official-5.vrm` | 643.3 KB | 643.0 KB | 368ms |
| `lobster_plush.glb` | 553.3 KB | 556.8 KB | 426ms |
| `pineapple-house-opt1.glb?v=2` | 528.1 KB | 541.3 KB | 115ms |
| `patty-building-opt1.glb?v=2` | 327.2 KB | 494.5 KB | 94ms |
| `spongebob.glb` | 377.9 KB | 463.6 KB | 328ms |
| `bazaar-merchant-stand.glb?v=2` | 382.9 KB | 420.5 KB | 317ms |
| `salty-spitoon-opt1.glb?v=2` | 364.8 KB | 381.6 KB | 89ms |

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
