# Blender headless forensic pass 1 — cove-interior-STAGING.glb
# Goals:
#  1) TRUE inventory: every object/mesh/material/node name, bounds, vert/face counts
#  2) Flat-surface height histogram (up-facing faces, area-weighted, world Z)
#  3) Auto-cluster up-facing faces in the dominant mid-height bands -> candidate tables
#  4) Renders: top ortho, iso, side + top view with cluster bounding markers
import bpy, json, math, os, sys
from mathutils import Vector

SP = r"C:\Users\itachi\AppData\Local\Temp\claude\C--Users-itachi-documents-crypto-clawville\3bc476e4-a8f0-4e94-bfc4-6df4f4030265\scratchpad"
GLB = os.path.join(SP, "cove-glb", "cove-interior-STAGING.glb")
OUT = os.path.join(SP, "cove-forensics")
os.makedirs(OUT, exist_ok=True)

# ---------- clean scene ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
others = [o for o in bpy.data.objects if o.type != 'MESH']

# ---------- 1) inventory ----------
inv = {"objects": [], "non_mesh_nodes": [], "materials": [m.name for m in bpy.data.materials]}
scene_min = Vector((1e9, 1e9, 1e9)); scene_max = Vector((-1e9, -1e9, -1e9))
for o in meshes:
    mw = o.matrix_world
    bb = [mw @ Vector(c) for c in o.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    scene_min = Vector((min(scene_min.x, mn.x), min(scene_min.y, mn.y), min(scene_min.z, mn.z)))
    scene_max = Vector((max(scene_max.x, mx.x), max(scene_max.y, mx.y), max(scene_max.z, mx.z)))
    inv["objects"].append({
        "name": o.name,
        "parent": o.parent.name if o.parent else None,
        "verts": len(o.data.vertices),
        "faces": len(o.data.polygons),
        "materials": [ms.material.name if ms.material else None for ms in o.material_slots],
        "bbox_min": [round(v, 3) for v in mn],
        "bbox_max": [round(v, 3) for v in mx],
        "dims": [round(v, 3) for v in (mx - mn)],
    })
for o in others:
    inv["non_mesh_nodes"].append({"name": o.name, "type": o.type,
                                  "parent": o.parent.name if o.parent else None,
                                  "loc": [round(v, 3) for v in o.matrix_world.translation]})
inv["scene_bbox_min"] = [round(v, 3) for v in scene_min]
inv["scene_bbox_max"] = [round(v, 3) for v in scene_max]
inv["scene_dims"] = [round(v, 3) for v in (scene_max - scene_min)]

# ---------- 2) up-facing flat surface histogram ----------
# collect (area, z, cx, cy, obj_name) for every up-facing polygon
BIN = 0.05  # 5cm z bins
faces_up = []
hist = {}
for o in meshes:
    mw = o.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()  # normal matrix
    verts = o.data.vertices
    for p in o.data.polygons:
        n = (nm @ p.normal)
        if n.length == 0:
            continue
        n.normalize()
        if n.z < 0.9:
            continue
        ws = [mw @ verts[i].co for i in p.vertices]
        z = sum(v.z for v in ws) / len(ws)
        # world-space polygon area via fan triangulation
        area = 0.0
        for i in range(1, len(ws) - 1):
            area += ((ws[i] - ws[0]).cross(ws[i + 1] - ws[0])).length * 0.5
        cx = sum(v.x for v in ws) / len(ws)
        cy = sum(v.y for v in ws) / len(ws)
        faces_up.append((area, z, cx, cy, o.name))
        b = round(z / BIN) * BIN
        hist[round(b, 2)] = hist.get(round(b, 2), 0.0) + area
hist_sorted = sorted(hist.items(), key=lambda kv: -kv[1])
inv["upface_z_histogram_top40"] = [[k, round(v, 2)] for k, v in hist_sorted[:40]]

# ---------- 3) cluster candidate table bands ----------
# consider bands clearly above floor and below 2/3 room height
floor_z = scene_min.z
room_h = (scene_max.z - scene_min.z) or 1.0
def in_table_range(z):
    rel = (z - floor_z) / room_h
    return 0.04 < rel < 0.65
bands = [(k, v) for k, v in hist_sorted if in_table_range(k) and v > 0.5][:6]
clusters_out = []
for band_z, band_area in bands:
    fs = [f for f in faces_up if abs(f[1] - band_z) <= BIN * 1.5]
    # greedy union clustering by XY proximity
    clusters = []
    for area, z, cx, cy, oname in fs:
        placed = False
        for c in clusters:
            if abs(cx - c["cx"]) < 2.5 and abs(cy - c["cy"]) < 2.5:
                tot = c["area"] + area
                c["cx"] = (c["cx"] * c["area"] + cx * area) / tot
                c["cy"] = (c["cy"] * c["area"] + cy * area) / tot
                c["area"] = tot
                c["minx"] = min(c["minx"], cx); c["maxx"] = max(c["maxx"], cx)
                c["miny"] = min(c["miny"], cy); c["maxy"] = max(c["maxy"], cy)
                c["objs"].add(oname)
                placed = True
                break
        if not placed:
            clusters.append({"cx": cx, "cy": cy, "area": area,
                             "minx": cx, "maxx": cx, "miny": cy, "maxy": cy,
                             "objs": {oname}})
    clusters = [c for c in clusters if c["area"] > 0.3]
    clusters.sort(key=lambda c: -c["area"])
    clusters_out.append({
        "band_z": band_z, "band_area": round(band_area, 2),
        "clusters": [{
            "cx": round(c["cx"], 2), "cy": round(c["cy"], 2),
            "area": round(c["area"], 2),
            "extent_x": round(c["maxx"] - c["minx"], 2),
            "extent_y": round(c["maxy"] - c["miny"], 2),
            "objs": sorted(c["objs"]),
        } for c in clusters[:12]],
    })
inv["candidate_bands"] = clusters_out

with open(os.path.join(OUT, "inventory.json"), "w") as f:
    json.dump(inv, f, indent=1)

# ---------- 4) renders ----------
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'FLAT'
scene.display.shading.color_type = 'MATERIAL'
scene.render.resolution_x = 1600
scene.render.resolution_y = 1200
scene.render.film_transparent = False
center = (scene_min + scene_max) / 2
diag = (scene_max - scene_min).length

cam_data = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam); scene.camera = cam
cam_data.clip_end = diag * 10

def render(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

# top ortho
cam_data.type = 'ORTHO'
cam_data.ortho_scale = max(scene_max.x - scene_min.x, scene_max.y - scene_min.y) * 1.1
cam.location = (center.x, center.y, scene_max.z + diag)
cam.rotation_euler = (0, 0, 0)
render(os.path.join(OUT, "render_top.png"))

# iso persp
cam_data.type = 'PERSP'; cam_data.lens = 35
cam.location = (center.x + diag * 0.7, center.y - diag * 0.7, center.z + diag * 0.55)
d = center - cam.location
cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
render(os.path.join(OUT, "render_iso.png"))

# side ortho (to eyeball heights)
cam_data.type = 'ORTHO'
cam_data.ortho_scale = max(scene_max.y - scene_min.y, scene_max.z - scene_min.z) * 1.2
cam.location = (center.x + diag * 2, center.y, center.z)
d = center - cam.location
cam.rotation_euler = d.to_track_quat('-Z', 'Z').to_euler()
render(os.path.join(OUT, "render_side.png"))

# cluster-marker top view: emissive-red flat quads over each candidate cluster
import bmesh
mark_mat = bpy.data.materials.new("MARK")
mark_mat.use_nodes = False
mark_mat.diffuse_color = (1, 0, 0, 1)
scene.display.shading.color_type = 'MATERIAL'
best_band = None
if clusters_out:
    # pick the band whose big clusters look most "table-sized" (extent 1..8 units, >=2 clusters)
    def score(b):
        cs = [c for c in b["clusters"] if 0.8 < max(c["extent_x"], c["extent_y"]) < 12]
        return (len([c for c in cs if c["area"] > 1.0]), b["band_area"])
    best_band = max(clusters_out, key=score)
    for i, c in enumerate(best_band["clusters"][:10]):
        m = bpy.data.meshes.new(f"mark{i}")
        bm = bmesh.new()
        x0, x1 = c["cx"] - max(c["extent_x"], 0.6) / 2, c["cx"] + max(c["extent_x"], 0.6) / 2
        y0, y1 = c["cy"] - max(c["extent_y"], 0.6) / 2, c["cy"] + max(c["extent_y"], 0.6) / 2
        z = best_band["band_z"] + 0.15
        vs = [bm.verts.new(v) for v in [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]]
        bm.faces.new(vs)
        bm.to_mesh(m); bm.free()
        ob = bpy.data.objects.new(f"MARK_{i}", m)
        ob.data.materials.append(mark_mat)
        scene.collection.objects.link(ob)
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(scene_max.x - scene_min.x, scene_max.y - scene_min.y) * 1.1
    cam.location = (center.x, center.y, scene_max.z + diag)
    cam.rotation_euler = (0, 0, 0)
    render(os.path.join(OUT, "render_clusters_top.png"))
    with open(os.path.join(OUT, "best_band.json"), "w") as f:
        json.dump(best_band, f, indent=1)

print("FORENSICS_PASS1_DONE meshes=%d upfaces=%d bands=%d" % (len(meshes), len(faces_up), len(clusters_out)))
