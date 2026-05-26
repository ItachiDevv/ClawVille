"""
Paste this into Blender's Text Editor and hit Run (Alt+P) — or drop into Python Console.
It reads scripts/breast-dent-fixes.json and pushes recessed breast verts forward to their
pre-Mixamo Z positions.

Axis mapping (glTF data → Blender world):
  glTF +Z (forward)  →  Blender +Y
  glTF +Y (up)       →  Blender +Z
  glTF +X (right)    →  Blender +X

Strategy:
- Find the body mesh (a single mesh with ~11,319 verts, largest single-mesh in the scene
  matching the expected chest bbox).
- For each fix entry, find the vert closest (in world space) to the entry's current_pos.
  Require match within 3mm — skip if not found (topology drift protection).
- Apply new position: set vert.co.y = target_y_in_blender (which is glTF target_z).
  Leave X and Z alone — we only push forward, no lateral or vertical shift.
"""

import json
import bpy
from pathlib import Path
from mathutils import Vector

JSON_PATH = Path(r"C:\Users\newma\Documents\Crypto\ClawVille\scripts\breast-dent-fixes.json")
MATCH_TOLERANCE_MM = 3.0  # skip a fix entry if no current-scene vert is within 3mm

data = json.loads(JSON_PATH.read_text())
fixes = data["fixes"]
print(f"[fix] Loaded {len(fixes)} fix entries from {JSON_PATH.name}")

# Find the body mesh — pick the mesh object with ~11,319 verts whose bbox covers chest height
candidates = []
for obj in bpy.context.scene.objects:
    if obj.type != "MESH":
        continue
    n = len(obj.data.vertices)
    if not (11000 <= n <= 12000):
        continue
    candidates.append((obj, n))

if not candidates:
    raise RuntimeError(f"No body-mesh candidate found (expected ~11,319 verts). "
                       f"Meshes in scene: {[(o.name, len(o.data.vertices)) for o in bpy.context.scene.objects if o.type=='MESH']}")

if len(candidates) > 1:
    print(f"[fix] Multiple candidates: {[(o.name, n) for o,n in candidates]} — using first")

body_obj = candidates[0][0]
print(f"[fix] Target body mesh: '{body_obj.name}' ({len(body_obj.data.vertices)} verts)")

# Map glTF coords → Blender world coords:
# glTF (x, y, z) → Blender (x, z, y)  — glTF +Z-forward → Blender +Y-forward
def gltf_to_blender(p):
    return Vector((p[0], p[2], p[1]))

# Build world-position array of current Blender verts
mw = body_obj.matrix_world
verts = body_obj.data.vertices
world_positions = [mw @ v.co for v in verts]

# For each fix entry, find nearest-by-world-distance vert in current scene
tolerance_m = MATCH_TOLERANCE_MM / 1000.0
applied = 0
skipped_no_match = 0
skipped_already_ok = 0
max_delta_applied = 0.0

# We'll write in local coords — compute inverse of world matrix
mw_inv = mw.inverted()

for fix in fixes:
    target_gltf = fix["current_pos"]  # glTF coords of this vert in the Mixamo-rigged glb
    target_gltf_z = fix["target_z"]
    target_world = gltf_to_blender(target_gltf)

    # Nearest Blender vert
    best_i = -1
    best_d2 = float("inf")
    for i, wp in enumerate(world_positions):
        d2 = (wp - target_world).length_squared
        if d2 < best_d2:
            best_d2 = d2
            best_i = i

    if best_i < 0 or best_d2 ** 0.5 > tolerance_m:
        skipped_no_match += 1
        continue

    v = verts[best_i]
    current_world = world_positions[best_i]

    # Compute target world position: keep X, Z of current; set Y = target_gltf_z
    new_world = Vector((current_world.x, target_gltf_z, current_world.z))
    delta_m = (new_world - current_world).length

    if delta_m < 0.0005:  # already within 0.5mm
        skipped_already_ok += 1
        continue

    # Convert target world → local coords (through the object's matrix)
    new_local = mw_inv @ new_world
    v.co = new_local
    applied += 1
    if delta_m > max_delta_applied:
        max_delta_applied = delta_m

body_obj.data.update()

print(f"[fix] Applied:          {applied}")
print(f"[fix] Skipped (no NN):  {skipped_no_match}")
print(f"[fix] Skipped (already):{skipped_already_ok}")
print(f"[fix] Max delta applied:{max_delta_applied*1000:.2f}mm")
print(f"[fix] Done. Tab to Object Mode → save file (Ctrl+S).")
