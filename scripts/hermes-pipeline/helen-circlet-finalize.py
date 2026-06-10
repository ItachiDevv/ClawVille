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

# FACE MIDLINE — the slab centroid (cx) is pulled sideways by asymmetric hair
# mass, which off-centered the pendant. Anchor it to the actual face centerline:
# the front-most forehead verts (the face is convex, so front-most = center).
_f = [v.co for v in mesh.data.vertices
      if abs(v.co.z - band_z) < 0.02 and (v.co.y - cy) < -0.04 and abs(v.co.x - cx) < 0.09]
_f.sort(key=lambda p: p.y)
_front = _f[:max(60, len(_f)//10)]
face_mid_x = sum(p.x for p in _front) / len(_front)
print(f"[circlet] face_mid_x={face_mid_x:.4f} (slab cx was {cx:.4f})")

def _bx(i):
    th = (i/N)*2*math.pi
    return cx + (rmax[i] + SURF_OFFSET)*math.cos(th)
# pendant bin = the front-hemisphere band point that crosses the face midline
front_bins = [i for i in range(N) if math.sin((i/N)*2*math.pi) < -0.5]
pend_bin = min(front_bins, key=lambda i: abs(_bx(i) - face_mid_x))
pend_th = (pend_bin/N)*360.0
print(f"[circlet] pendant bin={pend_bin} theta={pend_th:.1f}deg (270 would be slab-front)")

def band_point(i):
    th = (i/N)*2*math.pi
    r = rmax[i] + SURF_OFFSET
    # angular distance from the pendant anchor (face midline), not the slab front
    dfront = abs(((math.degrees(th) - pend_th) + 180) % 360 - 180)
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

# pendant at the face midline: bead on the band + teardrop below
front = band_point(pend_bin)
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

# ---- hair roll (braided crown) over the melted upper-forehead zone ----
ROLL_RAISE   = 0.011   # roll center this far above the band
ROLL_R       = 0.017   # tube radius (thick hair roll)
ROLL_SPAN    = 105.0   # degrees each side of the pendant anchor (ear to ear)
roll_curve = bpy.data.curves.new("HairRollCurve", 'CURVE')
roll_curve.dimensions = '3D'
rsp = roll_curve.splines.new('POLY')
roll_pts = []
for i in range(N):
    th_deg = (i/N)*360.0
    dfront = abs(((th_deg - pend_th) + 180) % 360 - 180)
    if dfront <= ROLL_SPAN:
        roll_pts.append((i, dfront))
roll_pts.sort(key=lambda t: ((((t[0]/N)*360.0 - pend_th) + 180) % 360 - 180))
rsp.points.add(len(roll_pts)-1)
for k, (i, dfront) in enumerate(roll_pts):
    th = (i/N)*2*math.pi
    r = rmax[i] + 0.004
    z = band_z + ROLL_RAISE + 0.006*math.exp(-(dfront/70.0)**2)  # slight arc up at center
    rsp.points[k].co = (cx + r*math.cos(th), cy + r*math.sin(th), z, 1.0)
    # pinch the ends so the roll tucks into the side hair
    edge = max(0.0, (dfront - (ROLL_SPAN-28.0)) / 28.0)
    rsp.points[k].radius = max(0.18, 1.0 - edge)
roll_curve.bevel_depth = ROLL_R
roll_curve.bevel_resolution = 6
roll_curve.use_fill_caps = True
roll_obj = bpy.data.objects.new("HairRoll", roll_curve)
bpy.context.collection.objects.link(roll_obj)
bpy.ops.object.select_all(action="DESELECT")
roll_obj.select_set(True); bpy.context.view_layer.objects.active = roll_obj
bpy.ops.object.convert(target='MESH')
roll_obj = bpy.context.view_layer.objects.active
bpy.ops.object.shade_smooth()

# streaky blonde hair texture so the roll doesn't read as plastic
import numpy as _np
TS = 256
rng = _np.random.default_rng(7)
base = _np.array((0.500, 0.390, 0.215), dtype=_np.float32)
vv = _np.linspace(0, 1, TS, endpoint=False)
phase = rng.uniform(0, 6.28, 8)
stripes = _np.zeros(TS, dtype=_np.float32)
for k_ in range(8):
    stripes += _np.sin(vv * 6.283 * (10 + 7*k_) + phase[k_]) / (k_ + 2)
stripes = (stripes - stripes.min()) / (_np.ptp(stripes) + 1e-6)   # 0..1 strand pattern
tex = _np.empty((TS, TS, 4), dtype=_np.float32)
shade = (0.72 + 0.55 * stripes)[:, None].repeat(TS, 1)
jitter = rng.normal(0, 0.03, (TS, TS)).astype(_np.float32)
for c_ in range(3):
    tex[:, :, c_] = _np.clip(base[c_] * (shade + jitter), 0, 1)
tex[:, :, 3] = 1.0
hair_img = bpy.data.images.new("HairRollTex", TS, TS, alpha=True)
hair_img.pixels.foreach_set(tex.reshape(-1))
hair_img.pack()
hair_mat = bpy.data.materials.new("HairRoll")
hair_mat.use_nodes = True
hb_ = next(n for n in hair_mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
ht_ = hair_mat.node_tree.nodes.new(type="ShaderNodeTexImage")
ht_.image = hair_img
hair_mat.node_tree.links.new(ht_.outputs["Color"], hb_.inputs["Base Color"])
hb_.inputs["Roughness"].default_value = 0.65
hb_.inputs["Metallic"].default_value = 0.0
# body materials carry Meshy's baked-light emissive — match the roll so it doesn't sit dark
if hb_.inputs.get("Emission Strength"):
    hb_.inputs["Emission Strength"].default_value = 0.35
es_ = hb_.inputs.get("Emission Color")
if es_ is not None:
    hair_mat.node_tree.links.new(ht_.outputs["Color"], es_)
roll_obj.data.materials.append(hair_mat)
roll_obj.parent = arm
rvg = roll_obj.vertex_groups.new(name="mixamorig:Head")
rvg.add(range(len(roll_obj.data.vertices)), 1.0, 'REPLACE')
rmod = roll_obj.modifiers.new("Armature", 'ARMATURE')
rmod.object = arm
print(f"[circlet] hair roll verts={len(roll_obj.data.vertices)}")

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

# ---- 4b. FOREHEAD REPAIR: the melted diadem is BOTH raised geometry AND paint ----
# Meshy modeled the source circlet as raised relief on the forehead and painted
# gold over it. Two-part fix: (1) Laplacian-smooth the relief flat, (2) replace
# the painted patch with the median skin tone modulated by LOW-FREQUENCY
# luminance only (keeps soft shading, kills the painted pattern).
import numpy as np

# (1) flatten the raised relief
sm = 0
for v in mesh.data.vertices:
    p = v.co
    dz = p.z - band_z
    hw = 0.058 - max(dz, 0.0) * (0.058 - 0.030) / 0.095   # trapezoid: wide at band, narrower at the parting
    v.select = (-0.004 < dz < 0.095 and p.y < cy and abs(p.x - face_mid_x) < hw)
    sm += v.select
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True); bpy.context.view_layer.objects.active = mesh
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_mode(type="VERT")
bpy.ops.object.mode_set(mode="OBJECT")   # sync selection set in object mode
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.vertices_smooth(factor=0.5, repeat=24)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"[circlet] smoothed forehead relief: {sm} verts")

# (2) repaint the patch
diffuse_img = None
for slot in mesh.material_slots:
    m_ = slot.material
    if not m_ or not m_.use_nodes: continue
    b_ = next((x for x in m_.node_tree.nodes if x.type == "BSDF_PRINCIPLED"), None)
    if b_ and b_.inputs["Base Color"].is_linked:
        src_ = b_.inputs["Base Color"].links[0].from_node
        if src_.type == "TEX_IMAGE" and src_.image and src_.image.size[0] >= 512:
            diffuse_img = src_.image; break
assert diffuse_img is not None, "no diffuse image found for retouch"
W, Himg = diffuse_img.size
buf = np.empty(W*Himg*4, dtype=np.float32)
diffuse_img.pixels.foreach_get(buf)
px = buf.reshape(Himg, W, 4)

me = mesh.data
me.calc_loop_triangles()
uvl = me.uv_layers.active.data
co = np.array([v.co[:] for v in me.vertices], dtype=np.float64)

# patch region: band line up to the hairline, front half, centered on face midline
_dz = co[:,2] - band_z
_hw = 0.050 - np.clip(_dz, 0.0, None) * (0.050 - 0.030) / 0.030
in_patch = ((_dz > -0.012) & (_dz < 0.030)
            & (co[:,1] < cy) & (np.abs(co[:,0] - face_mid_x) < _hw))
# clean-skin sample region: just below the band (above the brows)
_ax = np.abs(co[:,0] - face_mid_x)
in_skin  = ((_dz > 0.000) & (_dz < 0.030) & (co[:,1] < cy - 0.05)
            & (_ax > 0.052) & (_ax < 0.072))

mask = np.zeros((Himg, W), dtype=np.float32)
skin_uv = []
for tri in me.loop_triangles:
    vs = tri.vertices
    hit_patch = in_patch[vs[0]] or in_patch[vs[1]] or in_patch[vs[2]]
    hit_skin  = in_skin[vs[0]]  or in_skin[vs[1]]  or in_skin[vs[2]]
    if not (hit_patch or hit_skin): continue
    p = np.array([uvl[l].uv[:] for l in tri.loops]) * (W, Himg)
    if hit_skin:
        skin_uv.append(p.mean(0))
    if not hit_patch: continue
    x0, y0 = np.maximum(np.floor(p.min(0)).astype(int) - 1, 0)
    x1, y1 = np.minimum(np.ceil(p.max(0)).astype(int) + 1, (W-1, Himg-1))
    if x1 <= x0 or y1 <= y0: continue
    xs, ys = np.meshgrid(np.arange(x0, x1+1), np.arange(y0, y1+1))
    d = (p[1,1]-p[2,1])*(p[0,0]-p[2,0]) + (p[2,0]-p[1,0])*(p[0,1]-p[2,1])
    if abs(d) < 1e-9: continue
    a = ((p[1,1]-p[2,1])*(xs-p[2,0]) + (p[2,0]-p[1,0])*(ys-p[2,1])) / d
    bq = ((p[2,1]-p[0,1])*(xs-p[2,0]) + (p[0,0]-p[2,0])*(ys-p[2,1])) / d
    cq = 1 - a - bq
    inside = (a >= -0.03) & (bq >= -0.03) & (cq >= -0.03)
    mask[ys[inside], xs[inside]] = 1.0

skin_px = np.array([px[min(int(v), Himg-1), min(int(u), W-1), :3] for (u, v) in skin_uv])
skin_med = np.median(skin_px, axis=0)
skin_lum = float(skin_med @ (0.299, 0.587, 0.114))
print(f"[circlet] retouch mask={int((mask>0).sum())}px skin_med={np.round(skin_med,3)} from {len(skin_uv)} samples")

def boxblur(arr, r):
    # O(1) box blur via integral image, edge-clamped
    ii = np.pad(arr, ((1,0),(1,0))).cumsum(0).cumsum(1)
    Hh, Ww = arr.shape
    y0 = np.clip(np.arange(Hh) - r, 0, Hh); y1 = np.clip(np.arange(Hh) + r + 1, 0, Hh)
    x0 = np.clip(np.arange(Ww) - r, 0, Ww); x1 = np.clip(np.arange(Ww) + r + 1, 0, Ww)
    out = (ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0])
    area = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    return out / area

# feathered strength: blur the binary mask so the repaint fades at the borders
feather = boxblur(boxblur(mask, 8), 8)
feather = np.clip((feather - 0.15) / 0.7, 0.0, 1.0) * (mask > 0)

# low-frequency luminance inside the patch (kills the painted pattern, keeps shading)
lum_img = px[:, :, :3] @ np.array((0.299, 0.587, 0.114), dtype=np.float32)
lum_filled = np.where(mask > 0, lum_img, skin_lum)
lum_low = boxblur(lum_filled, 32)
# damp the kept shading toward flat skin — the painted pattern's baked shadows
# otherwise leak through as "low-frequency" structure
lum_low = skin_lum + (lum_low - skin_lum) * 0.45

ys_, xs_ = np.nonzero(feather > 0.02)
f = feather[ys_, xs_][:, None]
target = np.clip(skin_med[None, :] * (lum_low[ys_, xs_] / max(skin_lum, 1e-5))[:, None], 0.0, 1.0)
px[ys_, xs_, :3] = px[ys_, xs_, :3] * (1 - f) + target * f
print(f"[circlet] repainted {len(ys_)}px (feathered)")

diffuse_img.pixels.foreach_set(px.reshape(-1))
diffuse_img.update()
try: diffuse_img.pack()
except Exception as e: print(f"[circlet] repack warn: {e}")

# (3) REPAINT THE EMISSIVE COPY TOO. Meshy bakes its lighting into an emissive
# duplicate of the base color — it is LOAD-BEARING (killing it sinks the eyes
# and turns the face waxy; learned the hard way). So emission stays, and the
# same patch repaint is applied to the emissive image so the gold doesn't
# shine back through.
emis_img = None
for slot in mesh.material_slots:
    m_ = slot.material
    if not m_ or not m_.use_nodes: continue
    b_ = next((x for x in m_.node_tree.nodes if x.type == "BSDF_PRINCIPLED"), None)
    if not b_: continue
    sock = b_.inputs.get("Emission Color")
    if sock and sock.is_linked:
        src_ = sock.links[0].from_node
        if src_.type == "TEX_IMAGE" and src_.image and src_.image.size[0] == W:
            emis_img = src_.image
if emis_img is not None:
    ebuf = np.empty(W*Himg*4, dtype=np.float32)
    emis_img.pixels.foreach_get(ebuf)
    epx = ebuf.reshape(Himg, W, 4)
    elum_img = epx[:, :, :3] @ np.array((0.299, 0.587, 0.114), dtype=np.float32)
    elum_filled = np.where(mask > 0, elum_img, skin_lum)
    elum_low = boxblur(elum_filled, 32)
    elum_low = skin_lum + (elum_low - skin_lum) * 0.45
    etarget = np.clip(skin_med[None, :] * (elum_low[ys_, xs_] / max(skin_lum, 1e-5))[:, None], 0.0, 1.0)
    epx[ys_, xs_, :3] = epx[ys_, xs_, :3] * (1 - f) + etarget * f
    emis_img.pixels.foreach_set(epx.reshape(-1))
    emis_img.update()
    try: emis_img.pack()
    except Exception as e: print(f"[circlet] emissive repack warn: {e}")
    print(f"[circlet] emissive copy repainted ({emis_img.name})")
else:
    print("[circlet] WARN: no emissive texture found (skipping emissive repaint)")

# (4) FLATTEN THE NORMAL MAP in the patch — the melted diadem relief is baked
# into the normals; geometry smoothing alone can't remove that shading.
normal_img = None
for slot in mesh.material_slots:
    m_ = slot.material
    if not m_ or not m_.use_nodes: continue
    for n_ in m_.node_tree.nodes:
        if n_.type == "NORMAL_MAP" and n_.inputs["Color"].is_linked:
            src_ = n_.inputs["Color"].links[0].from_node
            if src_.type == "TEX_IMAGE" and src_.image:
                normal_img = src_.image; break
if normal_img is not None and normal_img.size[0] == W and normal_img.size[1] == Himg:
    nbuf = np.empty(W*Himg*4, dtype=np.float32)
    normal_img.pixels.foreach_get(nbuf)
    npx = nbuf.reshape(Himg, W, 4)
    flat = np.array((0.5, 0.5, 1.0), dtype=np.float32)
    npx[ys_, xs_, :3] = npx[ys_, xs_, :3] * (1 - f) + flat[None, :] * f
    normal_img.pixels.foreach_set(npx.reshape(-1))
    normal_img.update()
    try: normal_img.pack()
    except Exception as e: print(f"[circlet] normal repack warn: {e}")
    print(f"[circlet] flattened normal map in patch ({len(ys_)}px)")
else:
    print(f"[circlet] WARN: normal map not found or size mismatch — relief shading will remain")

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
head_t = Vector((face_mid_x, cy, band_z + 0.01))
shot("face.png",  head_t + Vector((0, -0.6, 0)), head_t, H*0.24)
shot("face-three-quarter.png", head_t + Vector((-0.42, -0.42, 0.06)), head_t, H*0.24)
shot("forehead.png", head_t + Vector((0, -0.5, 0.01)), head_t + Vector((0, 0, 0.015)), H*0.10)
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
