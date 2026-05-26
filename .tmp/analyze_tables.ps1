# Three.js gltf loader auto-converts Y-up (gltf) to Z-up (Three.js).
# Blender's Y axis -> Three.js Z axis, Blender's Z axis -> Three.js Y axis
# So the autofit computeBoundingBox in Three.js sees:
#   Three.js X = Blender X (unchanged by gltf loader... actually gltf loader rotates -90deg X)
# The gltf importer in Three.js applies a root rotation of -90deg on X to convert Y-up to Z-up.
# This means:
#   gltf X -> three.js X
#   gltf Y -> three.js Z  (was Y-up, becomes depth in three.js)
#   gltf Z -> three.js -Y (was Z, inverted and becomes Y)
#
# BUT Blender's exporter already converts Z-up to Y-up via export_yup=True by default:
#   Blender X -> gltf X
#   Blender Y -> gltf Z  (blender Y is depth/forward)
#   Blender Z -> gltf Y  (blender Z is up)
# Combined: Blender X -> three.js X, Blender Y -> three.js Z, Blender Z -> three.js Y  (approximately)
# (with sign corrections applied by three.js loader)
#
# The actual Three.js GLTFLoader applies a rotation of PI on Y for the root scene node
# when it detects a Y-up asset. Actually it wraps in a quaternion from asset.up.
#
# In practice for this model: the bounds Blender sees are:
#   X: [-963, -477] (width ~485 units)
#   Y: [-508, +509] (length ~1016 units - this IS the maxDim)
#   Z: [-274, -71]  (height ~203 units)
#
# After Three.js loads: maxDim = ~1016, scale = 2000/1016 = 1.967
# The 1016-unit axis (Blender Y) becomes the room's "long" axis.
#
# For Three.js world positions, what matters is the world-space centroid relative to the autofit center.
# The autofit in the code uses THREE.Box3.getCenter() on the loaded scene,
# which will have applied the Y-up conversion.
#
# Since we only need to identify WHICH islands are "middle poker tables",
# let's use a simpler approach: look at the islands with substantial face counts
# that cluster spatially - tables should be similar-sized groups of islands
# positioned symmetrically in the room.

$j = Get-Content 'C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_islands.json' -Raw | ConvertFrom-Json
$islands = $j.islands

# Key transform from autofit in blender space (my Python used wrong formula)
# Correct formula from code: wx = (glbX - centerX) * scale, wy = (glbY - minY) * scale, wz = (glbZ - centerZ) * scale
# But this is Blender coordinates - we need to account for Y->Z axis swap after gltf export+import
#
# Blender Y is the long axis (1016 units) -> after gltf+threejs = THREE Z axis
# Blender X -> THREE X axis (approximately)
# Blender Z -> THREE Y axis (height)
#
# The autofit bounds computed in THREE.js will be:
#   three_bounds_X = blender_X mapped (centered around -720 blender)
#   three_bounds_Y = blender_Z mapped (height, was -274 to -71 blender = 203 wide)
#   three_bounds_Z = blender_Y mapped (long axis, was -508 to 509 blender = 1016 wide)
#
# Scale = 2000 / max(485, 203, 1016) = 2000/1016 = 1.967 ✓
#
# three_center_X = (-963 + -477) / 2 * 1.967 - offset... wait, let me use the actual bounds
# three_center from THREE.js = center of bounding box in three.js space
# three X range: after loading, corresponds to blender X: [-963, -477] -> width 485, center=-720
# three Z range: after loading, corresponds to blender Y: [-508, 509] -> width 1016, center=0.5
# three Y range: after loading, corresponds to blender Z: [-274, -71] -> width 203, center=-172.7
# (with possible sign/axis corrections)

# The world transform is: scale uniform 1.967, then position = (-center_THREE * scale)
# So world coords:
#   wX = (blenderX - (-720)) * 1.967  = (blenderX + 720) * 1.967
#   wY = (blenderZ - (-274)) * 1.967  = (blenderZ + 274) * 1.967  [floor at wY=0]
#   wZ = (blenderY - 0.5) * 1.967

# Spawn is at wZ = +800 => blenderY = 800/1.967 + 0.5 = 407.4 (but blender Y only goes to 509!)
# That puts spawn near the positive-Y end of the Blender model.

$scale = 1.9671392651514987
$centerX = -720.549732 # ((-963.236572 + (-477.876892)) / 2)
$minZ_blender = -274.3991394  # = min blender Z = floor
$centerY_blender = 0.29012870  # ((-508.0622863 + 508.6425476) / 2)

Write-Output "Center X Blender: $centerX"
Write-Output "Center Y Blender: $centerY_blender"
Write-Output "Min Z Blender (floor): $minZ_blender"
Write-Output ""

# Corrected world formula:
# wX = (blX - centerX) * scale   [three X]
# wY = (blZ - minZ) * scale       [three Y = height]
# wZ = (blY - centerY) * scale   [three Z = depth, spawn direction]

# Spawn wZ = +800 => blY = 800/scale + centerY = 406.9
# BUT blender Y only goes to +508.6, so blY=407 IS inside the model (near max-Y face)
Write-Output "Spawn blender Y equiv: $(800/$scale + $centerY_blender)"
Write-Output ""

# Now let's identify islands with reasonable table dimensions
# A poker table in a room with 1016 blender units long axis = 2000 world units
# so 1 world unit ~= 0.508 blender units
# A real poker table is ~2.7m x 1.2m. Room is probably ~10m x 4.5m (generous casino)
# In 2000 world units if avatar=270wu=1.7m, then 1m = 158.8wu
# Poker table would be ~2.7m * 158.8 = 429wu x 1.2m * 158.8 = 191wu
# In blender coords: 429/1.967 = 218 blender units long, 191/1.967 = 97 blender units wide

# So we want islands with local_size ~100-300 blender units in any horizontal dimension
Write-Output "=== ISLANDS with horizontal span > 30 blender units (potential furniture) ==="
$furniture = $islands | Where-Object {
    $sz = $_.local_size_xyz
    ($sz[0] -gt 30 -or $sz[1] -gt 30) -and $_.face_count -ge 4
}
Write-Output "Count: $($furniture.Count)"
$furniture | ForEach-Object {
    $gc = $_.glb_centroid
    $sz = $_.local_size_xyz
    # Recalc world using correct axis mapping
    $wX = ($gc[0] - $centerX) * $scale
    $wY = ($gc[2] - $minZ_blender) * $scale  # blender Z -> world Y (height)
    $wZ = ($gc[1] - $centerY_blender) * $scale  # blender Y -> world Z (depth)
    Write-Output "  [$($_.island_idx)] mesh=$($_.mesh) f=$($_.face_count) v=$($_.vert_count)"
    Write-Output "    BlenderXYZ: ($([math]::Round($gc[0],1)), $([math]::Round($gc[1],1)), $([math]::Round($gc[2],1)))"
    Write-Output "    WorldXYZ: ($([math]::Round($wX,1)), $([math]::Round($wY,1)), $([math]::Round($wZ,1)))"
    Write-Output "    SzXYZ: ($([math]::Round($sz[0],1)), $([math]::Round($sz[1],1)), $([math]::Round($sz[2],1)))"
}

Write-Output ""
Write-Output "=== DISTINCT mesh names ==="
$islands | ForEach-Object { $_.mesh } | Sort-Object -Unique | ForEach-Object { Write-Output "  $_" }

Write-Output ""
Write-Output "=== Island count per mesh ==="
$islands | Group-Object mesh | Sort-Object Count -Descending | Select-Object -First 20 | ForEach-Object {
    Write-Output "  $($_.Name): $($_.Count) islands"
}
