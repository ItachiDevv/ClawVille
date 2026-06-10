import bpy, os, sys
argv = sys.argv
ua = argv[argv.index("--")+1:] if "--" in argv else []
FBX = os.path.abspath(ua[0])
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.fbx(filepath=FBX, automatic_bone_orientation=True, ignore_leaf_bones=False, use_anim=False)
arm = next((o for o in bpy.context.scene.objects if o.type=="ARMATURE"), None)
meshes = [o for o in bpy.context.scene.objects if o.type=="MESH"]
print(f"[inspect] FBX={FBX}")
print(f"[inspect] armature={'YES '+arm.name if arm else 'NONE'} bones={len(arm.data.bones) if arm else 0}")
print(f"[inspect] mesh_count={len(meshes)}")
total_v=total_t=0
import bmesh
for m in meshes:
    me = m.data
    me.calc_loop_triangles()
    total_v += len(me.vertices); total_t += len(me.loop_triangles)
    # bbox in world
    bb = [m.matrix_world @ __import__('mathutils').Vector(c) for c in m.bound_box]
    xs=[v.x for v in bb]; ys=[v.y for v in bb]; zs=[v.z for v in bb]
    print(f"[inspect]   mesh '{m.name}': verts={len(me.vertices)} tris={len(me.loop_triangles)} mats={[s.material.name if s.material else None for s in m.material_slots]}")
    print(f"[inspect]   bbox dX(armspan?)={max(xs)-min(xs):.3f} dY(depth?)={max(ys)-min(ys):.3f} dZ(height)={max(zs)-min(zs):.3f}")
print(f"[inspect] TOTAL verts={total_v} tris={total_t}")
# textures / images
imgs=[(i.name, i.size[0], i.size[1], i.packed_file is not None) for i in bpy.data.images if i.size[0]>0]
print(f"[inspect] images={imgs}")
