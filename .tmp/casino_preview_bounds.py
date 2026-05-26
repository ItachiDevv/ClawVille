"""
Preview the deletion bounds: analyze what's inside X[-645, -505], Y[100, 440].
Report face centroids and confirm only table geometry is selected.
Also verify the right wall is NOT included.
"""
import bpy
import math

GLB_PATH = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"

BL_X_MIN = -645.0
BL_X_MAX = -505.0
BL_Y_MIN =  100.0
BL_Y_MAX =  440.0

CTR_X = -720.6
CTR_Y =    0.3
MIN_Z = -274.4
SCALE = 1.9671

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)

def main():
    print("=== Deletion Bounds Preview ===", flush=True)
    print(f"Bounds: blX [{BL_X_MIN}, {BL_X_MAX}], blY [{BL_Y_MIN}, {BL_Y_MAX}]", flush=True)

    reset_scene()
    import_glb(GLB_PATH)

    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']

    # Count total verts
    total_verts = sum(len(o.data.vertices) for o in meshes)
    print(f"Total mesh verts: {total_verts:,}", flush=True)

    # Count faces in target zone
    zone_verts = 0
    zone_faces = 0
    wall_faces = 0  # faces near right wall blX > -505 as sanity check

    for obj in meshes:
        mat = obj.matrix_world
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.faces.ensure_lookup_table()

        for face in bm.faces:
            cx = sum(v.co.x for v in face.verts) / len(face.verts)
            cy = sum(v.co.y for v in face.verts) / len(face.verts)
            import mathutils
            wco = mat @ mathutils.Vector((cx, cy, 0))
            wx, wy = wco.x, wco.y

            if BL_X_MIN <= wx <= BL_X_MAX and BL_Y_MIN <= wy <= BL_Y_MAX:
                zone_faces += 1
            # Check wall region to ensure we're not touching it
            if wx > -510 and BL_Y_MIN <= wy <= BL_Y_MAX:
                wall_faces += 1

        bm.free()

    # Also count verts in zone
    for obj in meshes:
        mat = obj.matrix_world
        for v in obj.data.vertices:
            co = mat @ v.co
            if BL_X_MIN <= co.x <= BL_X_MAX and BL_Y_MIN <= co.y <= BL_Y_MAX:
                zone_verts += 1

    print(f"Faces in target zone: {zone_faces:,}", flush=True)
    print(f"Verts in target zone: {zone_verts:,}", flush=True)
    print(f"Faces near right wall (blX > -510, same Y range): {wall_faces:,} [should be 0]", flush=True)

    # World coordinates of deletion zone
    wX_min = (BL_X_MIN - CTR_X) * SCALE
    wX_max = (BL_X_MAX - CTR_X) * SCALE
    wZ_min = (BL_Y_MIN - CTR_Y) * SCALE
    wZ_max = (BL_Y_MAX - CTR_Y) * SCALE
    print(f"\nWorld X range: {wX_min:.0f} to {wX_max:.0f}", flush=True)
    print(f"World Z range: {wZ_min:.0f} to {wZ_max:.0f}", flush=True)
    print(f"(Spawn is at world Z=+800, so deletion zone is Z={wZ_min:.0f} to {wZ_max:.0f})", flush=True)

    # Sample some face centroids in zone to visually confirm they're table-height
    print("\n--- Sample face centroids in zone (first 10 by blY) ---", flush=True)
    samples = []
    for obj in meshes:
        mat = obj.matrix_world
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.faces.ensure_lookup_table()
        for face in bm.faces:
            cx = sum(v.co.x for v in face.verts) / len(face.verts)
            cy = sum(v.co.y for v in face.verts) / len(face.verts)
            cz = sum(v.co.z for v in face.verts) / len(face.verts)
            import mathutils
            wco = mat @ mathutils.Vector((cx, cy, cz))
            wx, wy, wz = wco.x, wco.y, wco.z
            if BL_X_MIN <= wx <= BL_X_MAX and BL_Y_MIN <= wy <= BL_Y_MAX:
                wY = (wz - MIN_Z) * SCALE
                wZ = (wy - CTR_Y) * SCALE
                wX = (wx - CTR_X) * SCALE
                samples.append((wy, wX, wY, wZ, obj.name))
        bm.free()

    samples.sort(key=lambda x: x[0])
    for s in samples[:10]:
        print(f"  blY={s[0]:.1f} -> worldXYZ=({s[1]:.0f}, {s[2]:.0f}, {s[3]:.0f}) mesh={s[4]}", flush=True)

    print("\n=== Done ===", flush=True)

if __name__ == "__main__":
    main()
