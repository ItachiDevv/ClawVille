"""
Helen per-character cleanup (hermes-style manual pass): MODEL the gold forehead
circlet as real geometry — image-to-3D melted the source's filigree diadem into
a soft textured band (fundamental i2m limitation; re-rolling never fixes it).

Builds: adaptive gold band fitted to the ACTUAL head/hair cross-section at brow
height (polar-sampled from mesh verts, so it hugs the skin at the forehead and
rides on the hair at the sides/back) + center drop pendant. All circlet verts
weighted 1.0 to mixamorig:Head so it animates with the skull.

Then runs the standard finalize (same as blender-vrm-finalize-rigged.py):
native-scale import, height assert, gentle dedup, humanoid bones, VRM 1.0.

Usage:
  blender --background --python helen-circlet-finalize.py -- <rigged.fbx> <out.vrm> <preview-dir> [render-only]
"""
import bpy, os, sys, math
from mathutils import Vector

argv = sys.argv
ua = argv[argv.index("--")+1:] if "--" in argv else []
if len(ua) not in (3, 4):
    print("usage: ... -- <rigged.fbx> <out.vrm> <preview-dir> [render-only]"); sys.exit(1)
FBX_PATH = os.path.abspath(ua[0]); VRM_PATH = os.path.abspath(ua[1]); PREVIEW = os.path.abspath(ua[2])
RENDER_ONLY = (len(ua) == 4 and ua[3] == "render-only")
os.makedirs(PREVIEW, exist_ok=True)

# ---- tunables (iterated against the approved turnaround) ----
BAND_DROP   = 0.112   # band height = top of hair - this (m)
BAND_DIP    = 0.011   # extra sag at front center (V-dip toward nose bridge)
DIP_HALF    = 55.0    # deg half-width of the dip falloff
SURF_OFFSET = 0.0035  # band floats this far off the surface
BEVEL_R     = 0.0033  # band tube radius
PEND_BEAD_R = 0.0046  # bead where pendant meets band
PEND_LEN    = 0.017   # teardrop length below bead
GOLD        = (0.78, 0.55, 0.14, 1.0)

# ---- 0. clean slate ----
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for blk in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.curves):
    for it in list(blk):
        if it.users == 0: blk.remove(it)

# ---- 1. VRM addon ----
addons = bpy.context.preferences.addons
if not any(m in addons for m in ("bl_ext.user_default.vrm","bl_ext.blender_org.vrm","io_scene_vrm")):
    for m in ("bl_ext.user_default.vrm","bl_ext.blender_org.vrm","io_scene_vrm"):
        try: bpy.ops.preferences.addon_enable(module=m); break
        except Exception: pass

# ---- 2. import rigged FBX, native scale ----
print(f"[circlet] import {FBX_PATH}")
bpy.ops.import_scene.fbx(filepath=FBX_PATH, automatic_bone_orientation=True,
                         ignore_leaf_bones=False, use_anim=False)
arm  = next((o for o in bpy.context.scene.objects if o.type=="ARMATURE"), None)
mesh = next((o for o in bpy.context.scene.objects if o.type=="MESH"), None)
assert arm and mesh, "need armature + mesh"
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True); mesh.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

zs = [(mesh.matrix_world @ Vector(c)).z for c in mesh.bound_box]
TOP = max(zs); H = TOP - min(zs)
print(f"[circlet] height={H:.3f} top={TOP:.3f}")
assert 1.0 <= H <= 2.6, f"height {H:.2f} not human"

# ---- 3. gentle dedup (same as finalize-rigged) ----
v0 = len(mesh.data.vertices)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True); bpy.context.view_layer.objects.active = mesh
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=0.00001)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"[circlet] dedup {v0} -> {len(mesh.data.vertices)}")

# ---- 4. fit the band to the real head cross-section ----
band_z = TOP - BAND_DROP
SLAB = 0.008
# head-region verts only (T-pose arms are far in x; head is near x=0)
pts = [v.co for v in mesh.data.vertices
       if abs(v.co.z - band_z) < SLAB and abs(v.co.x) < 0.22 and abs(v.co.y) < 0.25]
assert len(pts) > 200, f"only {len(pts)} verts in band slab — band_z wrong?"
cx = sum(p.x for p in pts)/len(pts); cy = sum(p.y for p in pts)/len(pts)
N = 96
rmax = [0.0]*N
for p in pts:
    th = math.atan2(p.y-cy, p.x-cx) % (2*math.pi)
    b = int(th/(2*math.pi)*N) % N
    r = math.hypot(p.x-cx, p.y-cy)
    if r > rmax[b]: rmax[b] = r
# fill empty bins from neighbors, then smooth (hair strands are spiky)
for i in range(N):
    if rmax[i] == 0.0:
        j = 1
        while rmax[(i-j)%N] == 0.0 and rmax[(i+j)%N] == 0.0: j += 1
        a_, b_ = rmax[(i-j)%N], rmax[(i+j)%N]
        rmax[i] = (a_+b_)/2 if a_ and b_ else (a_ or b_)
for _ in range(3):
    rmax = [(rmax[(i-1)%N] + 2*rmax[i] + rmax[(i+1)%N])/4 for i in range(N)]
print(f"[circlet] band_z={band_z:.3f} center=({cx:.3f},{cy:.3f}) r_front={rmax[int(0.75*N)]:.3f} r_back={rmax[int(0.25*N)]:.3f}")

# front of the head is -Y => theta = 270deg = bin 0.75*N
def band_point(i):
    th = (i/N)*2*math.pi
    r = rmax[i] + SURF_OFFSET
    # angular distance from front center (270 deg)
    dfront = abs(((math.degrees(th) - 270) + 180) % 360 - 180)
    dip = BAND_DIP * math.exp(-(dfront/DIP_HALF)**2)
    return Vector((cx + r*math.cos(th), cy + r*math.sin(th), band_z - dip))

curve = bpy.data.curves.new("CircletBand", 'CURVE')
curve.dimensions = '3D'
sp = curve.splines.new('POLY')
sp.points.add(N-1)
for i in range(N):
    p = band_point(i)
    sp.points[i].co = (p.x, p.y, p.z, 1.0)
sp.use_cyclic_u = True
curve.bevel_depth = BEVEL_R
curve.bevel_resolution = 6
band_obj = bpy.data.objects.new("Circlet", curve)
bpy.context.collection.objects.link(band_obj)
bpy.ops.object.select_all(action="DESELECT")
band_obj.select_set(True); bpy.context.view_layer.objects.active = band_obj
bpy.ops.object.convert(target='MESH')
band_obj = bpy.context.view_layer.objects.active

# pendant at front center: bead on the band + teardrop below
front = band_point(int(0.75*N))
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=PEND_BEAD_R,
                                     location=(front.x, front.y, front.z))
bead = bpy.context.view_layer.objects.active
bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=PEND_BEAD_R*1.35, radius2=0.0,
                                depth=PEND_LEN,
                                location=(front.x, front.y - 0.0015, front.z - PEND_BEAD_R - PEND_LEN/2),
                                rotation=(math.pi, 0, 0))
drop = bpy.context.view_layer.objects.active
bpy.ops.object.select_all(action="DESELECT")
band_obj.select_set(True); bead.select_set(True); drop.select_set(True)
bpy.context.view_layer.objects.active = band_obj
bpy.ops.object.join()
circlet = bpy.context.view_layer.objects.active
bpy.ops.object.shade_smooth()

# gold material
gold = bpy.data.materials.new("CircletGold")
gold.use_nodes = True
bsdf = next(n for n in gold.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Base Color"].default_value = GOLD
bsdf.inputs["Metallic"].default_value = 1.0
bsdf.inputs["Roughness"].default_value = 0.28
circlet.data.materials.append(gold)

# skin to head bone: armature modifier + all verts -> mixamorig:Head @ 1.0
circlet.parent = arm
vg = circlet.vertex_groups.new(name="mixamorig:Head")
vg.add(range(len(circlet.data.vertices)), 1.0, 'REPLACE')
mod = circlet.modifiers.new("Armature", 'ARMATURE')
mod.object = arm
print(f"[circlet] circlet verts={len(circlet.data.vertices)}")

# ---- 5. preview renders ----
for mt in bpy.data.materials:
    try: mt.blend_method = 'OPAQUE'
    except Exception: pass
bpy.context.scene.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new("W"); bpy.context.scene.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (1,1,1,1)
w.node_tree.nodes["Background"].inputs[1].default_value = 1.2
sd = bpy.data.lights.new("S","SUN"); sd.energy = 3.0
so = bpy.data.objects.new("S",sd); bpy.context.collection.objects.link(so)
so.rotation_euler = (math.radians(55), 0, math.radians(20))
scn = bpy.context.scene
try: scn.render.engine = 'BLENDER_EEVEE_NEXT'
except Exception:
    try: scn.render.engine = 'BLENDER_EEVEE'
    except Exception: pass
scn.render.resolution_x = 720; scn.render.resolution_y = 900
cam_d = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cam_d)
bpy.context.collection.objects.link(cam); scn.camera = cam
def look(frm, to):
    d = (frm - to).normalized()
    cam.location = frm
    cam.rotation_euler = d.to_track_quat('Z','Y').to_euler()
def shot(name, frm, to, ortho):
    cam_d.type = 'ORTHO'; cam_d.ortho_scale = ortho
    look(frm, to)
    scn.render.filepath = os.path.join(PREVIEW, name)
    bpy.ops.render.render(write_still=True)
    print(f"[circlet] render {name}")
head_t = Vector((cx, cy, band_z + 0.01))
shot("face.png",  head_t + Vector((0, -0.6, 0)), head_t, H*0.24)
shot("face-three-quarter.png", head_t + Vector((-0.42, -0.42, 0.06)), head_t, H*0.24)
shot("front.png", Vector((cx, cy - 1.2, H*0.5)), Vector((cx, cy, H*0.5)), H*1.1)

if RENDER_ONLY:
    print("[circlet] render-only — stopping before export"); sys.exit(0)

# ---- 6. humanoid bones + meta + export (same as finalize-rigged) ----
MAP = {
 "hips":"mixamorig:Hips","spine":"mixamorig:Spine","chest":"mixamorig:Spine1",
 "upper_chest":"mixamorig:Spine2","neck":"mixamorig:Neck","head":"mixamorig:Head",
 "left_shoulder":"mixamorig:LeftShoulder","left_upper_arm":"mixamorig:LeftArm",
 "left_lower_arm":"mixamorig:LeftForeArm","left_hand":"mixamorig:LeftHand",
 "right_shoulder":"mixamorig:RightShoulder","right_upper_arm":"mixamorig:RightArm",
 "right_lower_arm":"mixamorig:RightForeArm","right_hand":"mixamorig:RightHand",
 "left_upper_leg":"mixamorig:LeftUpLeg","left_lower_leg":"mixamorig:LeftLeg",
 "left_foot":"mixamorig:LeftFoot","left_toes":"mixamorig:LeftToeBase",
 "right_upper_leg":"mixamorig:RightUpLeg","right_lower_leg":"mixamorig:RightLeg",
 "right_foot":"mixamorig:RightFoot","right_toes":"mixamorig:RightToeBase",
}
names = {b.name for b in arm.data.bones}
ext = arm.data.vrm_addon_extension
ext.spec_version = "1.0"
hb = ext.vrm1.humanoid.human_bones
n = 0
for slot, mx in MAP.items():
    if mx not in names: continue
    try: getattr(hb, slot).node.bone_name = mx; n += 1
    except AttributeError: pass
print(f"[circlet] humanoid bones {n}/{len(MAP)}")

# base color sRGB + pack (body material came embedded in the FBX)
for slot in mesh.material_slots:
    mat = slot.material
    if not mat or not mat.use_nodes: continue
    b = next((x for x in mat.node_tree.nodes if x.type=="BSDF_PRINCIPLED"), None)
    if b and b.inputs["Base Color"].is_linked:
        src = b.inputs["Base Color"].links[0].from_node
        if src.type == "TEX_IMAGE" and src.image:
            src.image.colorspace_settings.name = "sRGB"
            if not src.image.packed_file:
                try: src.image.pack()
                except Exception: pass

meta = ext.vrm1.meta
meta.vrm_name = "helen"; meta.version = "1.1.0"
meta.authors.clear(); a = meta.authors.add(); a.value = "ClawVille"
meta.copyright_information = "ClawVille internal asset"

os.makedirs(os.path.dirname(VRM_PATH), exist_ok=True)
bpy.ops.export_scene.vrm(filepath=VRM_PATH, export_invisibles=False, enable_advanced_preferences=False)
print(f"[circlet] DONE {VRM_PATH} ({os.path.getsize(VRM_PATH)/1024:.0f} KB)")
