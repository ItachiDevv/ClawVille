"""
Precise per-table extent analysis.
The 3 arch tables at spawn side span blY ~300..510.
We need to identify them as separate clusters in XY and report:
- blender bounding box
- world bounding box
- vertex + face counts
"""
import bpy
import math

GLB_PATH = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"

CTR_X = -720.5568
CTR_Y =    0.2901
MIN_Z = -274.3991
SCALE = 1.9671392

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb():
    bpy.ops.import_scene.gltf(filepath=GLB_PATH)

def w(bx, by, bz):
    """Blender → World coords."""
    wX = (bx - CTR_X) * SCALE
    wY = (bz - MIN_Z) * SCALE
    wZ = (by - CTR_Y) * SCALE
    return (wX, wY, wZ)

def main():
    print("=== Table Extent Analysis ===", flush=True)
    reset_scene()
    import_glb()

    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']

    # Collect all vertices from Material3 family (likely table surfaces) and Material2 family
    # within the spawn-zone blY range [280..510]
    # Group by X-split into 3 tables based on the floor plan:
    # The 3 arches appear to span the full width (blX ~-963 to -478)
    # But they're at different Y positions OR at same Y but different X thirds.
    #
    # From the floor plan: 3 arches side by side at bottom = same blY range, spanning X
    # Let's look at blY=340..510 and split by X thirds:
    # Room width blX: -963 to -478 = 485 units
    # Left third: blX < -963 + 485/3 = -963 + 162 = -801
    # Middle third: -801 to -801+162 = -639
    # Right third: > -639

    # Collect all vertices in spawn zone with Y in [280..510]
    spawn_verts = []
    total_meshes_checked = 0
    for obj in meshes:
        if not any(obj.name.startswith(p) for p in ['Material3', 'Material2']):
            continue
        total_meshes_checked += 1
        mat = obj.matrix_world
        for v in obj.data.vertices:
            wco = mat @ v.co
            if 280 <= wco.y <= 510:
                spawn_verts.append({
                    'blX': wco.x, 'blY': wco.y, 'blZ': wco.z,
                    'mesh': obj.name,
                })

    print(f"Vertices in spawn zone (blY 280..510): {len(spawn_verts)} from {total_meshes_checked} meshes", flush=True)

    # X boundaries
    if spawn_verts:
        all_x = [v['blX'] for v in spawn_verts]
        all_y = [v['blY'] for v in spawn_verts]
        print(f"blX range: {min(all_x):.1f} to {max(all_x):.1f}", flush=True)
        print(f"blY range: {min(all_y):.1f} to {max(all_y):.1f}", flush=True)

    # The floor plan shows 3 distinct arch outlines. Let's split by X thirds
    # to count each arch separately.
    X_LEFT_BOUND  = -801  # left arch: blX < -801
    X_RIGHT_BOUND = -639  # right arch: blX > -639
    # middle arch: -801 <= blX <= -639

    groups = {
        "LEFT_TABLE  (blX < -801)":  [v for v in spawn_verts if v['blX'] < X_LEFT_BOUND],
        "CENTER_TABLE (-801...-639)": [v for v in spawn_verts if X_LEFT_BOUND <= v['blX'] <= X_RIGHT_BOUND],
        "RIGHT_TABLE  (blX > -639)":  [v for v in spawn_verts if v['blX'] > X_RIGHT_BOUND],
    }

    print("\n--- Arch table groups (blY 280..510) ---", flush=True)
    for label, verts in groups.items():
        if not verts:
            print(f"  {label}: EMPTY", flush=True)
            continue
        xs = [v['blX'] for v in verts]
        ys = [v['blY'] for v in verts]
        zs = [v['blZ'] for v in verts]
        cx = sum(xs)/len(xs)
        cy = sum(ys)/len(ys)
        cz = sum(zs)/len(zs)
        wX, wY, wZ = w(cx, cy, cz)
        wX_min = (min(xs) - CTR_X) * SCALE
        wX_max = (max(xs) - CTR_X) * SCALE
        wZ_min = (min(ys) - CTR_Y) * SCALE
        wZ_max = (max(ys) - CTR_Y) * SCALE
        wY_min = (min(zs) - MIN_Z) * SCALE
        wY_max = (max(zs) - MIN_Z) * SCALE
        # Approximate face count: count unique mesh names
        meshnames = set(v['mesh'] for v in verts)
        print(f"  {label}", flush=True)
        print(f"    Vert count: {len(verts)}", flush=True)
        print(f"    Meshes: {meshnames}", flush=True)
        print(f"    Blender centroid: ({cx:.1f}, {cy:.1f}, {cz:.1f})", flush=True)
        print(f"    World centroid:   ({wX:.0f}, {wY:.0f}, {wZ:.0f})", flush=True)
        print(f"    World X span: {wX_min:.0f} to {wX_max:.0f}  ({wX_max-wX_min:.0f} wu wide)", flush=True)
        print(f"    World Z span: {wZ_min:.0f} to {wZ_max:.0f}  ({wZ_max-wZ_min:.0f} wu deep)", flush=True)
        print(f"    World Y span: {wY_min:.0f} to {wY_max:.0f}  ({wY_max-wY_min:.0f} wu tall)", flush=True)
        print(f"    Dist from spawn (wZ=800): {abs(wZ-800):.0f}", flush=True)

    # Also analyze each of the 4 Material3.004 columns seen in the back of the room
    # Back tables: blY in [-250...-50] (world Z = -394 to +0)
    print("\n--- Back table groups (blY -250..-50) ---", flush=True)
    back_verts = []
    for obj in meshes:
        if not obj.name.startswith('Material3.004'):
            continue
        mat = obj.matrix_world
        for v in obj.data.vertices:
            wco = mat @ v.co
            if -250 <= wco.y <= -50:
                back_verts.append({'blX': wco.x, 'blY': wco.y, 'blZ': wco.z})

    if back_verts:
        xs = [v['blX'] for v in back_verts]
        ys = [v['blY'] for v in back_verts]
        print(f"  Verts: {len(back_verts)}, blX: {min(xs):.0f}..{max(xs):.0f}, blY: {min(ys):.0f}..{max(ys):.0f}", flush=True)

    print("\n=== Done ===", flush=True)

if __name__ == "__main__":
    main()
