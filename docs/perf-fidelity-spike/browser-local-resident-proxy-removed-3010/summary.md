# Browser Performance Run: local-resident-proxy-removed-3010

Generated: 2026-06-08T07:06:23.227Z

- URL: http://localhost:3010/game?perf=1&cb=local-resident-proxy-removed-3010
- Ready: no; textures ready: no
- Quality tier: 4
- DPR: 0.65
- Render calls: 118
- Triangles: 462,052
- Visible buttons: 21
- Primitive building proxy meshes: 0
- Proxy-like named nodes: 0 (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: 51, total 27699ms, max 8575ms
- VRM loads captured: 12
- Texture upload: 215 textures via idle, -, max slice 121ms
- Resource transfer: 32.54 MB
- GLB/VRM resources: 68
- Screenshot: `game.png`

## Navigation

- TTFB: 488ms
- DOM interactive: 648ms
- DCL: 648ms
- Load: 940ms

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
| 5383ms | 8575ms | self |
| 19267ms | 4838ms | self |
| 14500ms | 3727ms | self |
| 26801ms | 2921ms | self |
| 24607ms | 1777ms | self |
| 18267ms | 798ms | self |
| 31762ms | 513ms | self |
| 14060ms | 363ms | self |
| 3528ms | 328ms | self |
| 5113ms | 270ms | self |

## Slowest VRM Loads

| Asset | Total | Fetch wait | Parse | Normalise | Bytes | Meshes | Skinned |
|---|---:|---:|---:|---:|---:|---:|---:|
| `eliza-chibi.vrm?v=2` | 27884ms | 114ms | 558ms | 3ms | 5.29 MB | 1 | 1 |
| `tekk.vrm` | 27209ms | 114ms | 724ms | 4ms | 1.95 MB | 1 | 1 |
| `hermes-male.vrm` | 26314ms | 114ms | 458ms | 4ms | 1.28 MB | 1 | 1 |
| `hermes-female.vrm` | 25654ms | 114ms | 349ms | 8ms | 1.62 MB | 1 | 1 |
| `milady-official-6.vrm` | 25161ms | 114ms | 206ms | 0ms | 216.9 KB | 7 | 7 |
| `milady-official-5.vrm` | 24852ms | 114ms | 152ms | 0ms | 643.0 KB | 8 | 8 |
| `milady-official-4.vrm` | 24585ms | 114ms | 3054ms | 1ms | 285.1 KB | 8 | 8 |
| `milady-official-3.vrm` | 21274ms | 115ms | 127ms | 0ms | 234.0 KB | 7 | 7 |
| `milady-official-1.vrm` | 19334ms | 115ms | 55ms | 1ms | 236.6 KB | 12 | 12 |
| `milady-official-2.vrm` | 19171ms | 115ms | 51ms | 0ms | 166.4 KB | 4 | 4 |
| `milady-official-8.vrm` | 19008ms | 115ms | 101ms | 2ms | 327.3 KB | 9 | 9 |
| `milady-official-7.vrm` | 13930ms | 113ms | 13812ms | 4ms | 281.9 KB | 6 | 6 |

## Texture Upload Slices

- Mode: idle
- Textures: 215
- Duration: -
- Slices: 21
- Max slice: 121ms

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
| `milady-chibi.vrm?v=2` | 5.57 MB | 5.57 MB | 1308ms |
| `eliza-chibi.vrm?v=2` | 5.29 MB | 5.29 MB | 1221ms |
| `quest-bounty-pavilion.glb?v=3` | 1.72 MB | 2.11 MB | 835ms |
| `tekk.vrm` | 1.95 MB | 1.95 MB | 625ms |
| `hermes-female.vrm` | 1.62 MB | 1.62 MB | 580ms |
| `shisha-oasis.glb` | 879.8 KB | 1.53 MB | 660ms |
| `chum-bucket-v2-opt1.glb?v=3` | 1.42 MB | 1.52 MB | 368ms |
| `hermes-male.vrm` | 1.28 MB | 1.28 MB | 566ms |
| `krusty-krab-v2-opt1.glb?v=3` | 962.8 KB | 1.14 MB | 272ms |
| `squidward-house-opt1.glb?v=4` | 1015.4 KB | 1.06 MB | 403ms |
| `patricks-rock-v2-opt1.glb?v=4` | 927.9 KB | 1012.1 KB | 371ms |
| `guide-rigged.glb` | 539.5 KB | 926.6 KB | 59ms |
| `claw-arcade-exterior-opt1.glb?v=3` | 689.0 KB | 785.5 KB | 297ms |
| `milady-official-5.vrm` | 643.3 KB | 643.0 KB | 463ms |
| `lobster_plush.glb` | 553.3 KB | 556.8 KB | 156ms |
| `pineapple-house-opt1.glb?v=2` | 528.1 KB | 541.3 KB | 138ms |
| `patty-building-opt1.glb?v=2` | 327.2 KB | 494.5 KB | 125ms |
| `spongebob.glb` | 377.9 KB | 463.6 KB | 126ms |
| `bazaar-merchant-stand.glb?v=2` | 382.9 KB | 420.5 KB | 407ms |
| `salty-spitoon-opt1.glb?v=2` | 364.8 KB | 381.6 KB | 109ms |

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
