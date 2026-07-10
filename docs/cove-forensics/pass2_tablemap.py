# Pass 2 — scale-aware table mapping + verifiable renders (ceiling clipped)
import bpy, json, os, colorsys
from mathutils import Vector

SP = r"C:\Users\itachi\AppData\Local\Temp\claude\C--Users-itachi-documents-crypto-clawville\3bc476e4-a8f0-4e94-bfc4-6df4f4030265\scratchpad"
GLB = os.path.join(SP, "cove-glb", "cove-interior-STAGING.glb")
OUT = os.path.join(SP, "cove-forensics")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']

scene_min = Vector((1e9,) * 3); scene_max = Vector((-1e9,) * 3)
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        scene_min = Vector(map(min, scene_min, w)); scene_max = Vector(map(max, scene_max, w))
center = (scene_min + scene_max) / 2
FLOOR = scene_min.z  # ~ -274.4

# ---- collect up-facing faces once ----
faces_up = []
for o in meshes:
    mw = o.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()
    verts = o.data.vertices
    for p in o.data.polygons:
        n = nm @ p.normal
        if n.length == 0: continue
        n.normalize()
        if n.z < 0.85: continue
        ws = [mw @ verts[i].co for i in p.vertices]
        z = sum(v.z for v in ws) / len(ws)
        area = 0.0
        for i in range(1, len(ws) - 1):
            area += ((ws[i] - ws[0]).cross(ws[i + 1] - ws[0])).length * 0.5
        cx = sum(v.x for v in ws) / len(ws); cy = sum(v.y for v in ws) / len(ws)
        faces_up.append((area, z, cx, cy, o.name))

def cluster(faces, join_dist):
    cl = []
    for area, z, cx, cy, oname in faces:
        hit = None
        for c in cl:
            if (c["minx"] - join_dist) < cx < (c["maxx"] + join_dist) and (c["miny"] - join_dist) < cy < (c["maxy"] + join_dist):
                hit = c; break
        if hit is None:
            cl.append({"minx": cx, "maxx": cx, "miny": cy, "maxy": cy,
                       "area": area, "zs": [z], "objs": {oname}})
        else:
            hit["minx"] = min(hit["minx"], cx); hit["maxx"] = max(hit["maxx"], cx)
            hit["miny"] = min(hit["miny"], cy); hit["maxy"] = max(hit["maxy"], cy)
            hit["area"] += area; hit["zs"].append(z); hit["objs"].add(oname)
    # merge overlapping clusters until stable
    changed = True
    while changed:
        changed = False
        for i in range(len(cl)):
            for j in range(i + 1, len(cl)):
                a, b = cl[i], cl[j]
                if a["minx"] - join_dist < b["maxx"] and b["minx"] - join_dist < a["maxx"] and \
                   a["miny"] - join_dist < b["maxy"] and b["miny"] - join_dist < a["maxy"]:
                    a["minx"] = min(a["minx"], b["minx"]); a["maxx"] = max(a["maxx"], b["maxx"])
                    a["miny"] = min(a["miny"], b["miny"]); a["maxy"] = max(a["maxy"], b["maxy"])
                    a["area"] += b["area"]; a["zs"] += b["zs"]; a["objs"] |= b["objs"]
                    cl.pop(j); changed = True
                    break
            if changed: break
    return cl

def summarize(cl):
    out = []
    for c in sorted(cl, key=lambda c: -c["area"]):
        out.append({
            "center": [round((c["minx"] + c["maxx"]) / 2, 1), round((c["miny"] + c["maxy"]) / 2, 1)],
            "extent": [round(c["maxx"] - c["minx"], 1), round(c["maxy"] - c["miny"], 1)],
            "top_z": round(sum(c["zs"]) / len(c["zs"]), 1),
            "area": round(c["area"], 1),
            "objs": sorted(c["objs"]),
        })
    return out

# card-table band: 20-35 units above floor; slot-top band: 45-70 above floor
table_faces = [f for f in faces_up if 20 < (f[1] - FLOOR) < 35 and f[0] > 0.5]
slot_faces  = [f for f in faces_up if 45 < (f[1] - FLOOR) < 70 and f[0] > 0.5]
tables = [c for c in cluster(table_faces, 25) if c["area"] > 800]
slots  = [c for c in cluster(slot_faces, 25) if c["area"] > 300]
result = {"floor_z": round(FLOOR, 2),
          "card_table_candidates": summarize(tables),
          "tall_furniture_tops": summarize(slots)}
with open(os.path.join(OUT, "table_map.json"), "w") as f:
    json.dump(result, f, indent=1)

# ---- distinct object colors ----
palette = {}
for i, o in enumerate(meshes):
    h = (i * 0.618034) % 1.0
    r, g, b = colorsys.hsv_to_rgb(h, 0.65, 0.95)
    o.color = (r, g, b, 1.0)
    palette[o.name] = [round(r, 2), round(g, 2), round(b, 2)]
with open(os.path.join(OUT, "color_legend.json"), "w") as f:
    json.dump(palette, f, indent=1)

# ---- markers ----
import bmesh
def add_marker(name, minx, maxx, miny, maxy, z, rgba):
    m = bpy.data.meshes.new(name); bm = bmesh.new()
    vs = [bm.verts.new(v) for v in [(minx, miny, z), (maxx, miny, z), (maxx, maxy, z), (minx, maxy, z)]]
    bm.faces.new(vs); bm.to_mesh(m); bm.free()
    ob = bpy.data.objects.new(name, m)
    ob.color = rgba
    bpy.context.scene.collection.objects.link(ob)
    return ob

markers = []
for i, c in enumerate(sorted(tables, key=lambda c: -c["area"])):
    z = max(c["zs"]) + 2.0
    markers.append(add_marker(f"TABLE_{i}", c["minx"], c["maxx"], c["miny"], c["maxy"], z, (1, 0, 0, 1)))
for i, c in enumerate(sorted(slots, key=lambda c: -c["area"])):
    z = max(c["zs"]) + 2.0
    markers.append(add_marker(f"SLOT_{i}", c["minx"], c["maxx"], c["miny"], c["maxy"], z, (1, 0.55, 0, 1)))

# ---- render setup ----
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'OBJECT'
scene.render.resolution_x = 1600
scene.render.resolution_y = 1200
cam_data = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam); scene.camera = cam

CEIL_CUT = -95.0  # render only below this (ceiling ~-71, trim ~-81)
def render(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

# 1) top ortho with ceiling clipped
cam_data.type = 'ORTHO'
cam_data.ortho_scale = max(scene_max.x - scene_min.x, scene_max.y - scene_min.y) * 1.08
cam.location = (center.x, center.y, 200.0)
cam.rotation_euler = (0, 0, 0)
cam_data.clip_start = 200.0 - CEIL_CUT   # start below ceiling
cam_data.clip_end = 200.0 - FLOOR + 50
render(os.path.join(OUT, "p2_top_marks.png"))

# 2) same top view WITHOUT markers (hide) for a clean look
for m in markers: m.hide_render = True
render(os.path.join(OUT, "p2_top_clean.png"))
for m in markers: m.hide_render = False

# 3) closeup iso of first table candidate
if tables:
    t = sorted(tables, key=lambda c: -c["area"])[0]
    tc = Vector(((t["minx"] + t["maxx"]) / 2, (t["miny"] + t["maxy"]) / 2, sum(t["zs"]) / len(t["zs"])))
    cam_data.type = 'PERSP'; cam_data.lens = 28
    cam_data.clip_start = 1.0; cam_data.clip_end = 5000
    cam.location = (tc.x + 120, tc.y - 120, tc.z + 90)
    d = tc - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    for m in markers: m.hide_render = True
    scene.display.shading.color_type = 'TEXTURE'
    render(os.path.join(OUT, "p2_table_closeup.png"))

print("PASS2_DONE tables=%d slots=%d" % (len(tables), len(slots)))
