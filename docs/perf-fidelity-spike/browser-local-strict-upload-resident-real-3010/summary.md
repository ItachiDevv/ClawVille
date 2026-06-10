# Browser Performance Run: local-strict-upload-resident-real-3010

Generated: 2026-06-08T07:13:10.557Z

- URL: http://localhost:3010/game?perf=1&cb=local-strict-upload-resident-real-3010
- Ready: no; textures ready: no
- Quality tier: 4
- DPR: 0.65
- Render calls: 1700
- Triangles: 780,906
- Visible buttons: 21
- Primitive building proxy meshes: 0
- Proxy-like named nodes: 0 (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: 214, total 33176ms, max 6947ms
- VRM loads captured: 13
- Texture upload: 215 textures via idle, -, max slice 6ms
- Resource transfer: 32.54 MB
- GLB/VRM resources: 68
- Screenshot: `game.png`

## Navigation

- TTFB: 553ms
- DOM interactive: 678ms
- DCL: 678ms
- Load: 1055ms

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
| 5274ms | 6947ms | self |
| 12648ms | 2610ms | self |
| 15712ms | 2340ms | self |
| 19066ms | 2240ms | self |
| 29003ms | 1536ms | self |
| 42421ms | 1437ms | self |
| 43868ms | 969ms | self |
| 41775ms | 639ms | self |
| 21764ms | 339ms | self |
| 12299ms | 285ms | self |

## Slowest VRM Loads

| Asset | Total | Fetch wait | Parse | Normalise | Bytes | Meshes | Skinned |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eliza-chibi.vrm?v=2` | 17365ms | 84ms | 236ms | 2ms | 5.29 MB | 1 | 1 |
| `tekk.vrm` | 17021ms | 84ms | 80ms | 4ms | 1.95 MB | 1 | 1 |
| `hermes-male.vrm` | 16490ms | 84ms | 133ms | 3ms | 1.28 MB | 1 | 1 |
| `hermes-female.vrm` | 16246ms | 84ms | 2361ms | 5ms | 1.62 MB | 1 | 1 |
| `milady-official-6.vrm` | 13767ms | 84ms | 104ms | 0ms | 216.9 KB | 7 | 7 |
| `milady-official-5.vrm` | 13529ms | 84ms | 141ms | 0ms | 643.0 KB | 8 | 8 |
| `milady-official-4.vrm` | 13264ms | 84ms | 37ms | 0ms | 285.1 KB | 8 | 8 |
| `milady-official-3.vrm` | 13100ms | 84ms | 31ms | 0ms | 234.0 KB | 7 | 7 |
| `milady-official-1.vrm` | 12968ms | 84ms | 43ms | 1ms | 236.6 KB | 12 | 12 |
| `milady-official-2.vrm` | 10526ms | 85ms | 37ms | 0ms | 166.4 KB | 4 | 4 |
| `milady-official-8.vrm` | 10383ms | 85ms | 60ms | 1ms | 327.3 KB | 9 | 9 |
| `milady-official-7.vrm` | 10219ms | 82ms | 10135ms | 2ms | 281.9 KB | 6 | 6 |
| `milady-chibi.vrm?v=2` | 325ms | 1ms | 317ms | 4ms | 5.57 MB | 1 | 1 |

## Texture Upload Slices

- Mode: idle
- Textures: 215
- Duration: -
- Slices: 159
- Max slice: 6ms

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
| `milady-chibi.vrm?v=2` | 5.57 MB | 5.57 MB | 1377ms |
| `eliza-chibi.vrm?v=2` | 5.29 MB | 5.29 MB | 1237ms |
| `quest-bounty-pavilion.glb?v=3` | 1.72 MB | 2.11 MB | 971ms |
| `tekk.vrm` | 1.95 MB | 1.95 MB | 692ms |
| `hermes-female.vrm` | 1.62 MB | 1.62 MB | 625ms |
| `shisha-oasis.glb` | 879.8 KB | 1.53 MB | 785ms |
| `chum-bucket-v2-opt1.glb?v=3` | 1.42 MB | 1.52 MB | 378ms |
| `hermes-male.vrm` | 1.28 MB | 1.28 MB | 608ms |
| `krusty-krab-v2-opt1.glb?v=3` | 962.8 KB | 1.14 MB | 288ms |
| `squidward-house-opt1.glb?v=4` | 1015.4 KB | 1.06 MB | 415ms |
| `patricks-rock-v2-opt1.glb?v=4` | 927.9 KB | 1012.1 KB | 339ms |
| `guide-rigged.glb` | 539.5 KB | 926.6 KB | 73ms |
| `claw-arcade-exterior-opt1.glb?v=3` | 689.0 KB | 785.5 KB | 267ms |
| `milady-official-5.vrm` | 643.3 KB | 643.0 KB | 469ms |
| `lobster_plush.glb` | 553.3 KB | 556.8 KB | 198ms |
| `pineapple-house-opt1.glb?v=2` | 528.1 KB | 541.3 KB | 148ms |
| `patty-building-opt1.glb?v=2` | 327.2 KB | 494.5 KB | 104ms |
| `spongebob.glb` | 377.9 KB | 463.6 KB | 146ms |
| `bazaar-merchant-stand.glb?v=2` | 382.9 KB | 420.5 KB | 383ms |
| `salty-spitoon-opt1.glb?v=2` | 364.8 KB | 381.6 KB | 95ms |

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
