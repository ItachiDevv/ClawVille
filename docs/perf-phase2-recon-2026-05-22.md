# Phase 2 Recon — Building Material Audit

**Date:** 2026-05-22  
**Scope:** 12 active building GLBs (from `BUILDING_GLBS` in `asset-preload-manifest.ts`)

## Summary

| Metric | Value |
|---|---|
| Total materials across 12 buildings | 142 |
| Total texture objects | 106 |
| Cross-building duplicate textures (same hash, ≥2 buildings) | 11 |
| Materials with UV tiling outside [0,1] | 41 |
| Estimated within-file dedup win (Strategy 2A) | ~8 texture refs saved |

## Per-Building Material Count

| GLB | File size | Materials | Textures |
|---|---|---|---|
| pineapple-house.glb | 543.8 KB | 8 | 8 |
| chum-bucket-v2.glb | 1.76 MB | 11 | 12 |
| krusty-krab-v2.glb | 1.51 MB | 20 | 21 |
| sandy-treedome-v3.glb | 4.17 MB | 15 | 0 |
| salty-spitoon.glb | 377.3 KB | 3 | 5 |
| boating-school.glb | 184.4 KB | 25 | 24 |
| patty-building.glb | 494.5 KB | 5 | 5 |
| building-lighthouse.glb | 57.8 KB | 1 | 1 |
| arcade/claw-arcade-exterior.glb | 4.04 MB | 34 | 11 |
| cove/cove-exterior.glb | 376.0 KB | 5 | 4 |
| patricks-rock-v2.glb | 1.17 MB | 6 | 7 |
| squidward-house.glb | 1.19 MB | 9 | 8 |

## Per-Building Material Details

### pineapple-house.glb (8 materials)

**FlowersMaterial**
  - baseColor: webp 65281×1 31.5 KB hash=53c04a453ae15768
**PathMaterial**
  - baseColor: webp 1025×1025 173.0 KB hash=488b332cd59ee9d1
**ChimneyMaterial**
  - baseColor: webp 1025×1025 17.6 KB hash=79593beee0c3bab1
**PineAppleMaterial**
  - baseColor: webp 1025×1025 63.9 KB hash=bf5265fb4f389b96
**DoorMaterial**
  - baseColor: webp 1025×1025 20.9 KB hash=612fe3c2abe0e188
**DoorWheelMaterial**
  - baseColor: webp 1025×1025 28.7 KB hash=424eb3b26396f1b6
**WindowMaterial**
  - baseColor: webp 1025×1025 15.6 KB hash=f2e4083f315f76e7
**CrownMaterial**
  - baseColor: webp 1025×1025 119.7 KB hash=cdff0c6a24baa360

### chum-bucket-v2.glb (11 materials)

**19_-_Default**
  - baseColor: jpg 256×128 14.7 KB hash=aa0567d8c9dc439f
  - normal: png 256×128 56.4 KB hash=d720843e0633bbf3
**10_-_Default**
  - baseColor: jpg 128×128 17.8 KB hash=49e2be4f3c6b9eda
**04_-_Default**
  - baseColor: png 256×256 77.1 KB hash=1674536008c98a7f
  - normal: png 256×256 131.4 KB hash=cd974708e66f5442
**09_-_Default**
  - baseColor: png 1024×1024 25.5 KB hash=6a91518ee6dcd15b
  - normal: png 512×512 759.2 KB hash=f0201c0960ba0fa3
**02_-_Default** ⚠️ UV tiling outside [0,1] (min=-88.662, max=186.618)
  - baseColor: png 1024×1024 222 B hash=4dda599966cee7a1
  - normal: png 512×512 394.8 KB hash=49bc9db4b77a615f
**03_-_Default**
  - baseColor: jpg 128×128 12.2 KB hash=640c495f61443ff2
  - normal: png 128×128 34.8 KB hash=dd6290467c0534aa
**07_-_Default**
  - baseColor: jpg 512×512 73.3 KB hash=b125936f3e0fc3c2
**14_-_Default**
  - normal: png 512×512 759.2 KB hash=f0201c0960ba0fa3
**13_-_Default**
**15_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.270, max=1.270)
**08_-_Default**

### krusty-krab-v2.glb (20 materials)

**02_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.138, max=1.138)
  - baseColor: jpg 512×256 91.4 KB hash=309dd1678328ab9c
  - normal: png 512×256 354.2 KB hash=db2101c424be4138
**20_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.037, max=1.037)
  - baseColor: png 256×256 71.4 KB hash=ad3ccf8759c55bb4
  - normal: png 256×256 90.0 KB hash=8e1fca49f5d3a48e
**03_-_Default**
  - baseColor: jpg 512×512 73.3 KB hash=b125936f3e0fc3c2
**17_-_Default**
**19_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.002, max=1.028)
  - baseColor: jpg 256×128 14.7 KB hash=aa0567d8c9dc439f
  - normal: png 256×128 56.4 KB hash=d720843e0633bbf3
**07_-_Default** ⚠️ UV tiling outside [0,1] (min=-151.768, max=152.670)
**15_-_Default**
  - baseColor: png 1024×1024 619 B hash=b5002e00e64ba705
**14_-_Default**
  - baseColor: png 1024×1024 627 B hash=6f4cbeffe3d2f8e2
  - normal: png 256×128 56.4 KB hash=d720843e0633bbf3
**08_-_Default**
  - baseColor: png 1024×1024 3.8 KB hash=a9627f5d46f09505
**09_-_Default**
  - baseColor: png 1024×1024 5.0 KB hash=e9417ce3c8b2fe0a
**13_-_Default**
  - baseColor: png 1024×1024 565 B hash=14566259c848ffa2
**21_-_Default**
**07_-_Default_0**
**10_-_Default**
  - baseColor: jpg 128×128 17.8 KB hash=49e2be4f3c6b9eda
**04_-_Default**
  - baseColor: png 256×256 77.1 KB hash=1674536008c98a7f
  - normal: png 256×256 131.4 KB hash=cd974708e66f5442
**22_-_Default**
**16_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.054, max=1.081)
  - baseColor: png 256×128 21.0 KB hash=13d47ce96a595c9a
  - normal: png 256×128 35.4 KB hash=578f9416b9eadee8
**05_-_Default** ⚠️ UV tiling outside [0,1] (min=-1.762, max=2.762)
  - baseColor: jpg 128×128 12.2 KB hash=640c495f61443ff2
  - normal: png 128×128 34.8 KB hash=dd6290467c0534aa
**11_-_Default**
**06_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.051, max=1.166)
  - baseColor: jpg 128×128 14.1 KB hash=73236c94bd81c270
  - normal: png 128×128 34.8 KB hash=dd6290467c0534aa

### sandy-treedome-v3.glb (15 materials)

**kelabu**
**hijau**
**pasir_revisi.001**
**kelabu.001**
**hijau.002**
**kaca**
**seng**
**putih**
**cyan**
**pink**
**kayu**
**merah**
**hijau.001**
**transparan**
**tali**

### salty-spitoon.glb (3 materials)

**Material** ⚠️ UV tiling outside [0,1] (min=4977.000, max=60558.000)
  - baseColor: webp 65281×4 108.1 KB hash=6f429f0f77ef72f7
**Material.002** ⚠️ UV tiling outside [0,1] (min=14787.000, max=65407.000)
  - baseColor: webp 1025×513 47.0 KB hash=0cfd44f71db56125
  - metallicRoughness: webp 1025×513 15.4 KB hash=3561d4532264edc6
**Material.003** ⚠️ UV tiling outside [0,1] (min=64.000, max=65471.000)
  - baseColor: webp 1025×1025 81.2 KB hash=267a1c297137b323
  - metallicRoughness: webp 1025×1025 61.7 KB hash=2087c56b014caba6

### boating-school.glb (25 materials)

**Mesh_0056.rip** ⚠️ UV tiling outside [0,1] (min=-1.000, max=1.000)
  - baseColor: webp 65×65 254 B hash=42d6ff1217216724
**Mesh_0055.rip** ⚠️ UV tiling outside [0,1] (min=0.000, max=65535.000)
  - baseColor: webp 17×33 170 B hash=55887c880313ee6e
**Mesh_0054.rip**
  - baseColor: webp 65×65 1.3 KB hash=1b45d457c9815667
**Mesh_0032.rip** ⚠️ UV tiling outside [0,1] (min=0.000, max=65535.000)
  - baseColor: webp 33×33 158 B hash=b4a2f3bd5cb05403
**Mesh_0031.rip** ⚠️ UV tiling outside [0,1] (min=0.000, max=65535.000)
  - baseColor: webp 65×65 1.0 KB hash=02ec14a8cf375a1d
**Mesh_0030.rip** ⚠️ UV tiling outside [0,1] (min=-1.737, max=3.100)
  - baseColor: webp 65×65 1.2 KB hash=228ad9ee19f628f9
**Mesh_0023.rip** ⚠️ UV tiling outside [0,1] (min=-2.009, max=4.650)
  - baseColor: webp 65×65 478 B hash=4b3c722b5c840fb1
**Mesh_0022.rip** ⚠️ UV tiling outside [0,1] (min=-1.186, max=3.250)
  - baseColor: webp 33×33 112 B hash=2babb8ebaf7f5c8c
**Mesh_0021.rip** ⚠️ UV tiling outside [0,1] (min=-0.468, max=4.416)
  - baseColor: webp 65×65 812 B hash=889d9af6db67e4ae
**Mesh_0020.rip** ⚠️ UV tiling outside [0,1] (min=0.000, max=65535.000)
  - baseColor: webp 129×129 2.6 KB hash=92c1aafeaaf6df81
**Mesh_0019.rip** ⚠️ UV tiling outside [0,1] (min=0.002, max=1.081)
  - baseColor: webp 129×129 1.0 KB hash=bd44f565c0530a6f
**Mesh_0015.rip** ⚠️ UV tiling outside [0,1] (min=-1.654, max=4.685)
  - baseColor: webp 65×65 746 B hash=583ebe7791528b32
**Mesh_0012.rip**
  - baseColor: webp 129×129 3.4 KB hash=72dec4485880a321
**Mesh_0009.rip** ⚠️ UV tiling outside [0,1] (min=-1.455, max=2.335)
  - baseColor: webp 129×129 1.8 KB hash=17d2bd837735671d
**Mesh_0008.rip** ⚠️ UV tiling outside [0,1] (min=-0.973, max=1.833)
  - baseColor: webp 33×33 204 B hash=ef17fa67c6b099d5
**Mesh_0007.rip** ⚠️ UV tiling outside [0,1] (min=0.000, max=65535.000)
  - baseColor: webp 65×65 432 B hash=43fa7efaa67a3193
**Mesh_0004.rip**
  - baseColor: webp 257×129 4.4 KB hash=835fe630c1c9b467
**Mesh_0002.rip** ⚠️ UV tiling outside [0,1] (min=0.000, max=65535.000)
  - baseColor: webp 129×129 3.0 KB hash=7963a5a9db5853cb
**NDS_Material.033** ⚠️ UV tiling outside [0,1] (min=-0.763, max=0.999)
  - baseColor: webp 65×65 1.4 KB hash=7582e8a4368e99fd
**bluefish** ⚠️ UV tiling outside [0,1] (min=1136.000, max=64031.000)
  - baseColor: webp 129×129 2.8 KB hash=2ed223c2f4be905a
**NDS_Material** ⚠️ UV tiling outside [0,1] (min=768.000, max=64959.000)
  - baseColor: webp 65×65 1.3 KB hash=3c4280af0ef662a9
**NDS_Material.001** ⚠️ UV tiling outside [0,1] (min=0.000, max=63871.000)
  - baseColor: webp 33×33 482 B hash=6581dd78daca1bee
**NDS_Material.002**
  - baseColor: webp 33×257 2.6 KB hash=0393b9ce24686bdd
**NDS_Material.003**
**anchovy** ⚠️ UV tiling outside [0,1] (min=880.000, max=64655.000)
  - baseColor: webp 129×129 2.2 KB hash=66c24c68c7ac6918

### patty-building.glb (5 materials)

**Anchor1Mtl**
  - baseColor: webp 513×513 9.1 KB hash=496185c3d7c86138
**Building1Mtl**
  - baseColor: webp 513×513 20.7 KB hash=657c04172bc777e4
**Building2Mtl**
  - baseColor: webp 1025×1025 79.1 KB hash=2b23a2c8d5f2a17c
**MeshesooglecombinedMeshRootScene22970011Mtl**
  - baseColor: webp 513×513 24.8 KB hash=8676f1e300a4af14
**MesheszoomcombinedMeshRootScene21081Mtl**
  - baseColor: webp 513×513 18.5 KB hash=a1c734d2c06ed192

### building-lighthouse.glb (1 materials)

**lambert2SG** ⚠️ UV tiling outside [0,1] (min=336.000, max=50780.000)
  - baseColor: webp 257×257 1.3 KB hash=df40c000bd485d8b

### arcade/claw-arcade-exterior.glb (34 materials)

**blinn10**
**lambert27**
**lambert32**
**blinn14**
**lambert10**
**blinn8**
**blinn12**
**lambert8**
**lambert6**
**phong7**
**phong2**
  - baseColor: png 1024×1024 123.7 KB hash=eb319435f2cba1f7
**lambert1**
**phong4**
  - baseColor: png 512×512 113.7 KB hash=ae56ca5d7f1453a1
**lambert5**
**blinn3**
**blinn2**
**blinn6**
**blinn4**
**lambert4**
**phong6**
  - baseColor: png 1024×1024 193.0 KB hash=36466697c6ea308f
**phong5**
  - baseColor: png 512×512 127.2 KB hash=ff54fca9df590e63
**lambert12**
**blinn13**
**blinn1**
**lambert20**
  - baseColor: png 512×512 263.9 KB hash=4a753ba74c87abe0
**blinn9**
**lambert19**
  - baseColor: png 256×512 221.3 KB hash=d2bc4a4fb6cfc35c
**lambert21**
  - baseColor: png 256×256 65.0 KB hash=d42f60df598dcb75
**lambert33**
  - baseColor: png 1024×1024 900.8 KB hash=1c45a65bbce49dd3
**lambert14**
**lambert15**
**lambert18**
  - baseColor: jpg 128×128 21.6 KB hash=5b4765ddb2dfe242
**lambert17**
  - baseColor: png 512×512 346.1 KB hash=20c2e5fcf980abd5
**lambert16**
  - baseColor: png 1024×1024 1.54 MB hash=1cecd9eb4b31920c

### cove/cove-exterior.glb (5 materials)

**material_0**
  - baseColor: jpg 512×512 65.3 KB hash=ffb8e3a12188fae5
**material_1**
  - baseColor: jpg 512×512 65.3 KB hash=ffb8e3a12188fae5
**material_2**
  - baseColor: jpg 256×128 34.8 KB hash=e972f132f515c41e
  - emissive: jpg 256×128 34.8 KB hash=e972f132f515c41e
**material_3**
  - baseColor: png 256×1 117 B hash=573afa5e3d816db7
  - emissive: png 256×1 117 B hash=573afa5e3d816db7
**material_4**
  - baseColor: png 512×256 45.7 KB hash=140be9f122c37e25
  - emissive: png 512×256 45.7 KB hash=140be9f122c37e25

### patricks-rock-v2.glb (6 materials)

**07_-_Default**
  - baseColor: jpg 128×128 3.7 KB hash=8f86c56d233ca1bd
**03_-_Default** ⚠️ UV tiling outside [0,1] (min=0.001, max=1.216)
  - baseColor: png 256×256 106.6 KB hash=8517612355c26340
  - normal: png 256×256 148.7 KB hash=79bd4253d7cd0393
**19_-_Default**
  - baseColor: jpg 256×128 4.1 KB hash=f6197a6672af1280
**02_-_Default** ⚠️ UV tiling outside [0,1] (min=0.171, max=1.216)
  - baseColor: jpg 512×512 25.2 KB hash=81ce933485641a72
  - normal: png 512×512 719.1 KB hash=c672c068f31e9fc1
**08_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.350, max=1.350)
  - baseColor: jpg 512×256 27.0 KB hash=64d7a577f3d6ba44
**09_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.631, max=1.045)

### squidward-house.glb (9 materials)

**13_-_Default**
  - baseColor: jpg 128×128 3.7 KB hash=8f86c56d233ca1bd
**14_-_Default**
  - baseColor: png 256×256 106.6 KB hash=8517612355c26340
  - normal: png 256×256 148.7 KB hash=79bd4253d7cd0393
**03_-_Default** ⚠️ UV tiling outside [0,1] (min=0.000, max=1.011)
  - baseColor: jpg 512×512 63.6 KB hash=b1fc48c45aba6ff5
  - normal: png 512×512 690.2 KB hash=8e8877550d85a09c
**09_-_Default** ⚠️ UV tiling outside [0,1] (min=0.000, max=1.029)
  - baseColor: jpg 128×128 4.2 KB hash=9ee4fff61f286a61
  - normal: png 128×128 48.1 KB hash=8f7a7fa3f64d0c5d
**07_-_Default** ⚠️ UV tiling outside [0,1] (min=-0.035, max=1.028)
  - metallicRoughness: png 256×128 22.7 KB hash=c8fc67696c6f8932
**02_-_Default** ⚠️ UV tiling outside [0,1] (min=0.000, max=1.028)
**08_-_Default**
**15_-_Default**
**19_-_Default**
  - baseColor: jpg 128×128 4.2 KB hash=9ee4fff61f286a61

## Cross-Building Texture Duplicates (hash matches across ≥2 buildings)

Found 11 texture(s) shared across multiple buildings:

**hash=aa0567d8c9dc439f** (2 buildings, 2 total refs)
  - chum-bucket-v2.glb / 19_-_Default / baseColor (256×128 jpg 14.7 KB)
  - krusty-krab-v2.glb / 19_-_Default / baseColor (256×128 jpg 14.7 KB)
**hash=d720843e0633bbf3** (2 buildings, 3 total refs)
  - chum-bucket-v2.glb / 19_-_Default / normal (256×128 png 56.4 KB)
  - krusty-krab-v2.glb / 19_-_Default / normal (256×128 png 56.4 KB)
  - krusty-krab-v2.glb / 14_-_Default / normal (256×128 png 56.4 KB)
**hash=49e2be4f3c6b9eda** (2 buildings, 2 total refs)
  - chum-bucket-v2.glb / 10_-_Default / baseColor (128×128 jpg 17.8 KB)
  - krusty-krab-v2.glb / 10_-_Default / baseColor (128×128 jpg 17.8 KB)
**hash=1674536008c98a7f** (2 buildings, 2 total refs)
  - chum-bucket-v2.glb / 04_-_Default / baseColor (256×256 png 77.1 KB)
  - krusty-krab-v2.glb / 04_-_Default / baseColor (256×256 png 77.1 KB)
**hash=cd974708e66f5442** (2 buildings, 2 total refs)
  - chum-bucket-v2.glb / 04_-_Default / normal (256×256 png 131.4 KB)
  - krusty-krab-v2.glb / 04_-_Default / normal (256×256 png 131.4 KB)
**hash=640c495f61443ff2** (2 buildings, 2 total refs)
  - chum-bucket-v2.glb / 03_-_Default / baseColor (128×128 jpg 12.2 KB)
  - krusty-krab-v2.glb / 05_-_Default / baseColor (128×128 jpg 12.2 KB)
**hash=dd6290467c0534aa** (2 buildings, 3 total refs)
  - chum-bucket-v2.glb / 03_-_Default / normal (128×128 png 34.8 KB)
  - krusty-krab-v2.glb / 05_-_Default / normal (128×128 png 34.8 KB)
  - krusty-krab-v2.glb / 06_-_Default / normal (128×128 png 34.8 KB)
**hash=b125936f3e0fc3c2** (2 buildings, 2 total refs)
  - chum-bucket-v2.glb / 07_-_Default / baseColor (512×512 jpg 73.3 KB)
  - krusty-krab-v2.glb / 03_-_Default / baseColor (512×512 jpg 73.3 KB)
**hash=8f86c56d233ca1bd** (2 buildings, 2 total refs)
  - patricks-rock-v2.glb / 07_-_Default / baseColor (128×128 jpg 3.7 KB)
  - squidward-house.glb / 13_-_Default / baseColor (128×128 jpg 3.7 KB)
**hash=8517612355c26340** (2 buildings, 2 total refs)
  - patricks-rock-v2.glb / 03_-_Default / baseColor (256×256 png 106.6 KB)
  - squidward-house.glb / 14_-_Default / baseColor (256×256 png 106.6 KB)
**hash=79bd4253d7cd0393** (2 buildings, 2 total refs)
  - patricks-rock-v2.glb / 03_-_Default / normal (256×256 png 148.7 KB)
  - squidward-house.glb / 14_-_Default / normal (256×256 png 148.7 KB)

## UV Tiling Warnings (materials with UV outside [0,1] — would break atlas)

| GLB | Material | UV min | UV max |
|---|---|---|---|
| chum-bucket-v2.glb | 02_-_Default | -88.662 | 186.618 |
| chum-bucket-v2.glb | 15_-_Default | -0.270 | 1.270 |
| krusty-krab-v2.glb | 02_-_Default | -0.138 | 1.138 |
| krusty-krab-v2.glb | 20_-_Default | -0.037 | 1.037 |
| krusty-krab-v2.glb | 19_-_Default | -0.002 | 1.028 |
| krusty-krab-v2.glb | 07_-_Default | -151.768 | 152.670 |
| krusty-krab-v2.glb | 16_-_Default | -0.054 | 1.081 |
| krusty-krab-v2.glb | 05_-_Default | -1.762 | 2.762 |
| krusty-krab-v2.glb | 06_-_Default | -0.051 | 1.166 |
| salty-spitoon.glb | Material | 4977.000 | 60558.000 |
| salty-spitoon.glb | Material.002 | 14787.000 | 65407.000 |
| salty-spitoon.glb | Material.003 | 64.000 | 65471.000 |
| boating-school.glb | Mesh_0056.rip | -1.000 | 1.000 |
| boating-school.glb | Mesh_0055.rip | 0.000 | 65535.000 |
| boating-school.glb | Mesh_0032.rip | 0.000 | 65535.000 |
| boating-school.glb | Mesh_0031.rip | 0.000 | 65535.000 |
| boating-school.glb | Mesh_0030.rip | -1.737 | 3.100 |
| boating-school.glb | Mesh_0023.rip | -2.009 | 4.650 |
| boating-school.glb | Mesh_0022.rip | -1.186 | 3.250 |
| boating-school.glb | Mesh_0021.rip | -0.468 | 4.416 |
| boating-school.glb | Mesh_0020.rip | 0.000 | 65535.000 |
| boating-school.glb | Mesh_0019.rip | 0.002 | 1.081 |
| boating-school.glb | Mesh_0015.rip | -1.654 | 4.685 |
| boating-school.glb | Mesh_0009.rip | -1.455 | 2.335 |
| boating-school.glb | Mesh_0008.rip | -0.973 | 1.833 |
| boating-school.glb | Mesh_0007.rip | 0.000 | 65535.000 |
| boating-school.glb | Mesh_0002.rip | 0.000 | 65535.000 |
| boating-school.glb | NDS_Material.033 | -0.763 | 0.999 |
| boating-school.glb | bluefish | 1136.000 | 64031.000 |
| boating-school.glb | NDS_Material | 768.000 | 64959.000 |
| boating-school.glb | NDS_Material.001 | 0.000 | 63871.000 |
| boating-school.glb | anchovy | 880.000 | 64655.000 |
| building-lighthouse.glb | lambert2SG | 336.000 | 50780.000 |
| patricks-rock-v2.glb | 03_-_Default | 0.001 | 1.216 |
| patricks-rock-v2.glb | 02_-_Default | 0.171 | 1.216 |
| patricks-rock-v2.glb | 08_-_Default | -0.350 | 1.350 |
| patricks-rock-v2.glb | 09_-_Default | -0.631 | 1.045 |
| squidward-house.glb | 03_-_Default | 0.000 | 1.011 |
| squidward-house.glb | 09_-_Default | 0.000 | 1.029 |
| squidward-house.glb | 07_-_Default | -0.035 | 1.028 |
| squidward-house.glb | 02_-_Default | 0.000 | 1.028 |

> Materials with UV tiling outside [0,1] MUST be excluded from any atlas strategy.

## Strategy Decision Matrix

| Strategy | Estimated material reduction | Risk | Recommendation |
|---|---|---|---|
| 2A — within-file `gltf-transform dedup` (materials + textures) | ~8 duplicate texture refs eliminated; material count unchanged unless two materials are byte-identical | Low — no UV rewrite | Consider as first pass |
| 2B — cross-building texture atlas | Potentially collapse 11 cross-building textures → shared atlas | High — UV rewrite needed; 41 materials with UV>1 must be excluded | Not recommended — low ROI or too many tiling exclusions |
| 2C — replace decorative sub-meshes with shared simple material | Low (affects only untextured sub-meshes) | Medium — visual quality loss on detailed buildings | Not recommended as primary |

### Decision: Strategy 2A — Within-file `gltf-transform dedup` + targeted material consolidation

**Rationale (quoting recon numbers):**

Strategy 2B (atlas) is **blocked** by the UV tiling data:
- **41/142 materials (29%)** have UV coordinates outside [0,1] — these cannot be atlased without rewriting every UV attribute in the affected primitives.
- Boating-school alone has **19 out of 25 materials** with extreme tiling (UV max up to 65535.000), making it entirely atlas-ineligible.
- Salty-spitoon: **all 3 materials** have UV max ≥60000 — atlas-ineligible.
- Lighthouse: **only 1 material**, UV max 50780 — atlas-ineligible.
- The 11 cross-building duplicates span exactly **2 building pairs** (chum-bucket/krusty-krab and patricks-rock/squidward). That is 11 texture objects out of 106 total (10.4%). Atlasing saves at most 11 GPU texture uploads — negligible versus the draw-call count, which is the actual bottleneck.

Strategy 2A delivers:
1. **Within-file dedup (`gltf-transform dedup` on all 12 GLBs):** merges byte-identical material objects and deduplicates texture references. Confirmed wins: cove-exterior (baseColor=emissive in 3 materials — 3 texture refs reduced to 1 image), krusty-krab normal map reuse. Estimated: ~8 texture ref deduplicates.
2. **Untextured material consolidation on high-material buildings:** arcade exterior has **34 materials of which 23 are untextured** (lambert/blinn/phong solid-color with no image). These can be merged by `{color, roughness, metalness}` bucket into 1–4 materials. Sandy-treedome has **15 untextured vertex-color materials** — same consolidation applies. This directly reduces draw calls for the two highest-offending buildings.
3. **Net estimated reduction:** arcade 34→~11 (23 untextured merged into ≤3 color buckets + 11 textured kept separate), sandy-treedome 15→~4, remaining 10 buildings unchanged. Total estimated: **142→~95 materials = ~47 draw calls saved**.

Combined with the existing `mergeStaticMeshesByMaterial` pass (which merges meshes within a material), this should bring building draw calls from ~133 toward the ≤50 target.

**UV tiling exclusion rule:** any material with UV outside [0,1] is left exactly as-is by the script — no geometry rewrite, no UV normalization.

