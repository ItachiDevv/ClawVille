import bpy, os, sys, math
from mathutils import Vector
argv = sys.argv
ua = argv[argv.index("--")+1:] if "--" in argv else []
FBX = os.path.abspath(ua[0]); OUT = os.path.abspath(ua[1])
os.makedirs(OUT, exist_ok=True)
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.fbx(filepath=FBX, automatic_bone_orientation=True, ignore_leaf_bones=False, use_anim=False)
meshes=[o for o in bpy.context.scene.objects if o.type=="MESH"]
# combined bbox
mn=Vector((1e9,1e9,1e9)); mx=Vector((-1e9,-1e9,-1e9))
for m in meshes:
    for c in m.bound_box:
        w=m.matrix_world @ Vector(c)
        mn=Vector((min(mn.x,w.x),min(mn.y,w.y),min(mn.z,w.z)))
        mx=Vector((max(mx.x,w.x),max(mx.y,w.y),max(mx.z,w.z)))
ctr=(mn+mx)*0.5; size=(mx-mn)
H=size.z
# force opaque materials + standard view (match browser; avoid alpha-hash phantom)
for mt in bpy.data.materials:
    try:
        mt.blend_method='OPAQUE'
    except Exception: pass
bpy.context.scene.view_settings.view_transform='Standard'
# world light
w=bpy.data.worlds.new("W"); bpy.context.scene.world=w; w.use_nodes=True
w.node_tree.nodes["Background"].inputs[0].default_value=(1,1,1,1)
w.node_tree.nodes["Background"].inputs[1].default_value=1.2
# sun
sd=bpy.data.lights.new("S","SUN"); sd.energy=3.0
so=bpy.data.objects.new("S",sd); bpy.context.collection.objects.link(so)
so.rotation_euler=(math.radians(55),0,math.radians(20))
scn=bpy.context.scene
try: scn.render.engine='BLENDER_EEVEE_NEXT'
except Exception:
    try: scn.render.engine='BLENDER_EEVEE'
    except Exception: pass
scn.render.resolution_x=720; scn.render.resolution_y=900; scn.render.film_transparent=False
cam_d=bpy.data.cameras.new("C"); cam=bpy.data.objects.new("C",cam_d); bpy.context.collection.objects.link(cam); scn.camera=cam
def look(camobj, frm, to):
    d=(frm-to).normalized()
    camobj.location=frm
    camobj.rotation_euler=d.to_track_quat('Z','Y').to_euler()
def render(name, frm, to, ortho_scale=None):
    if ortho_scale:
        cam_d.type='ORTHO'; cam_d.ortho_scale=ortho_scale
    else:
        cam_d.type='PERSP'; cam_d.lens=50
    look(cam, frm, to)
    scn.render.filepath=os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)
    print(f"[render] wrote {name}")
dist=max(size.x,size.z)*1.6
# FRONT = camera on -Y side looking toward +Y (a char facing -Y shows its face)
render("front.png", ctr+Vector((0,-dist,0)), ctr, ortho_scale=H*1.1)
# BACK = camera on +Y
render("back.png", ctr+Vector((0,dist,0)), ctr, ortho_scale=H*1.1)
# FACE closeup from front
head=Vector((ctr.x, mn.y, mx.z-H*0.08))
render("face.png", head+Vector((0,-H*0.35,0)), Vector((ctr.x, ctr.y, mx.z-H*0.09)), ortho_scale=H*0.22)
print("[render] DONE")
