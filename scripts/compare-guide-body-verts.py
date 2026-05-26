"""
Compare breast-region vertex positions between:
  pre-Mixamo:  apps/web/public/models/guide.glb           (2026-04-22 export)
  post-Mixamo: apps/web/public/models/guide-rigged.glb    (2026-04-23 rigged)

Pure Python + struct parsing of glTF 2.0 binary. No Blender, no heavy deps.
Finds the body mesh by largest primitive vert count, extracts position accessor
data, restricts to breast region bounding box, and reports the delta distribution.
"""

import json
import struct
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\newma\Documents\Crypto\ClawVille")
PRE = ROOT / "apps/web/public/models/guide.glb"
POST = ROOT / "apps/web/public/models/guide-rigged.glb"


def parse_glb(path: Path):
    """Returns (gltf_json_dict, binary_buffer_bytes)."""
    data = path.read_bytes()
    magic, version, total_len = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, f"Not a glb: magic={magic:#x}"
    assert version == 2, f"glTF version {version} not supported"

    # First chunk: JSON
    json_len, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A, f"Expected JSON chunk, got {json_type:#x}"
    json_bytes = data[20 : 20 + json_len]
    gltf = json.loads(json_bytes)

    # Second chunk: BIN
    bin_offset = 20 + json_len
    bin_len, bin_type = struct.unpack_from("<II", data, bin_offset)
    assert bin_type == 0x004E4942, f"Expected BIN chunk, got {bin_type:#x}"
    buf = data[bin_offset + 8 : bin_offset + 8 + bin_len]
    return gltf, buf


def read_accessor_vec3(gltf, buf, accessor_idx):
    """Returns list of (x,y,z) floats for a VEC3 FLOAT accessor."""
    acc = gltf["accessors"][accessor_idx]
    assert acc["type"] == "VEC3" and acc["componentType"] == 5126, f"unexpected accessor: {acc}"
    bv = gltf["bufferViews"][acc["bufferView"]]
    offset = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride", 12)
    count = acc["count"]
    verts = []
    for i in range(count):
        x, y, z = struct.unpack_from("<fff", buf, offset + i * stride)
        verts.append((x, y, z))
    return verts


def find_body_mesh(gltf, buf):
    """Largest single primitive by position-accessor count. Returns (mesh_name, verts)."""
    best = None
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            pos_idx = prim.get("attributes", {}).get("POSITION")
            if pos_idx is None:
                continue
            count = gltf["accessors"][pos_idx]["count"]
            if best is None or count > best[2]:
                best = (mesh.get("name", "<unnamed>"), pos_idx, count)
    if best is None:
        return None, []
    name, idx, _ = best
    return name, read_accessor_vec3(gltf, buf, idx)


def scan_meshes(gltf):
    rows = []
    for i, mesh in enumerate(gltf.get("meshes", [])):
        for j, prim in enumerate(mesh.get("primitives", [])):
            pos_idx = prim.get("attributes", {}).get("POSITION")
            if pos_idx is None:
                continue
            count = gltf["accessors"][pos_idx]["count"]
            rows.append((mesh.get("name", f"mesh{i}"), j, count))
    rows.sort(key=lambda r: -r[2])
    return rows


def main():
    print(f"Loading {PRE.name} ({PRE.stat().st_size:,} bytes)...")
    pre_gltf, pre_buf = parse_glb(PRE)
    print(f"Loading {POST.name} ({POST.stat().st_size:,} bytes)...")
    post_gltf, post_buf = parse_glb(POST)

    print("\n=== Pre-Mixamo meshes (top 10 by vert count) ===")
    for name, prim_j, count in scan_meshes(pre_gltf)[:10]:
        print(f"  {count:>7,} verts  prim[{prim_j}]  {name}")

    print("\n=== Post-Mixamo meshes (top 10 by vert count) ===")
    for name, prim_j, count in scan_meshes(post_gltf)[:10]:
        print(f"  {count:>7,} verts  prim[{prim_j}]  {name}")

    pre_name, pre_verts = find_body_mesh(pre_gltf, pre_buf)
    post_name, post_verts = find_body_mesh(post_gltf, post_buf)
    print(f"\nPre body mesh:  '{pre_name}'  ({len(pre_verts):,} verts)")
    print(f"Post body mesh: '{post_name}' ({len(post_verts):,} verts)")

    if len(pre_verts) != len(post_verts):
        print(f"\n!! Vert count mismatch ({len(pre_verts)} vs {len(post_verts)}) — Mixamo added verts.")
        print(f"   Delta: +{len(post_verts) - len(pre_verts)} verts in post-Mixamo body.")
        print(f"   Switching to nearest-neighbor comparison.\n")

    # glTF uses Y-up. Breast region estimate: Y in [0.9, 1.35] (chest vertical),
    # Z > 0 (forward), |X| < 0.2 (torso).
    # If the model is Z-up (Mixamo native), breast region: Z in [0.9, 1.35], Y > 0, |X| < 0.2.
    # We'll try both and pick whichever yields verts.
    def region(verts, yup):
        if yup:
            return [(i, v) for i, v in enumerate(verts)
                    if 0.85 <= v[1] <= 1.40 and v[2] > 0.02 and abs(v[0]) < 0.22]
        else:
            return [(i, v) for i, v in enumerate(verts)
                    if 0.85 <= v[2] <= 1.40 and v[1] > 0.02 and abs(v[0]) < 0.22]

    # Figure out up-axis by inspecting bbox
    def bbox(verts):
        xs, ys, zs = zip(*verts)
        return (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))

    pre_bb = bbox(pre_verts)
    post_bb = bbox(post_verts)
    print(f"Pre  bbox: X={pre_bb[0]}, Y={pre_bb[1]}, Z={pre_bb[2]}")
    print(f"Post bbox: X={post_bb[0]}, Y={post_bb[1]}, Z={post_bb[2]}")

    # glTF convention: Y is up, Z is forward. The auto-heuristic "largest range = up"
    # fails when the model is in A-pose (arm span > height). Hardcode Y-up here since
    # the bbox shows Y=(0.003, 1.309) = standing height, Z=(-0.15, 0.09) = front-back.
    pre_up = 1
    post_up = 1
    print(f"Pre up-axis: {pre_up} ({['X','Y','Z'][pre_up]})")
    print(f"Post up-axis: {post_up} ({['X','Y','Z'][post_up]})")

    def breast_region(verts, up):
        out = []
        for i, v in enumerate(verts):
            height = v[up]
            # Breast height as fraction of model height — roughly 60-75% up
            hmin, hmax = 0.85, 1.40  # assume scene-scaled to human meters
            if not (hmin <= height <= hmax):
                continue
            lateral_axes = [a for a in range(3) if a != up]
            lat1, lat2 = v[lateral_axes[0]], v[lateral_axes[1]]
            # Front-facing one of the two lateral axes should be > 0 (forward)
            # We don't know which — require at least one positive
            if max(lat1, lat2) < 0.02:
                continue
            # Torso width limit on the OTHER lateral axis
            if min(abs(lat1), abs(lat2)) > 0.22:
                continue
            out.append((i, v))
        return out

    pre_reg = breast_region(pre_verts, pre_up)
    post_reg = breast_region(post_verts, post_up)
    print(f"\nPre breast-region verts:  {len(pre_reg)}")
    print(f"Post breast-region verts: {len(post_reg)}")

    if len(pre_reg) < 20 or len(post_reg) < 20:
        print("\n!! One of the regions is empty — axis heuristic likely wrong. Stopping.")
        return 1

    # Nearest-neighbor from each POST vert to nearest PRE vert (O(n*m) — small n)
    def nearest(v, candidates):
        best_d = float('inf')
        best = None
        for i, c in candidates:
            d = (v[0]-c[0])**2 + (v[1]-c[1])**2 + (v[2]-c[2])**2
            if d < best_d:
                best_d = d
                best = c
        return best, best_d ** 0.5

    # glTF Y-up → forward is Z. X is lateral (arms). Hardcode.
    pre_fw = 2
    post_fw = 2
    print(f"Forward axis: Z (glTF Y-up convention)")

    # And tighten breast region — X must be small (torso), Z must be positive (front)
    def breast_region_strict(verts):
        out = []
        for i, v in enumerate(verts):
            x, y, z = v
            if not (0.95 <= y <= 1.25):   # chest height
                continue
            if abs(x) > 0.18:             # inside torso, not arms
                continue
            if z < 0.0:                    # forward half only
                continue
            out.append((i, v))
        return out

    pre_reg = breast_region_strict(pre_verts)
    post_reg = breast_region_strict(post_verts)
    print(f"Strict breast region — pre: {len(pre_reg)}, post: {len(post_reg)}")
    if len(pre_reg) < 20 or len(post_reg) < 20:
        print("!! Still empty. Stopping.")
        return 1

    # For each post vert, find nearest pre vert. Measure forward-axis delta.
    deltas = []
    for i, pv in post_reg:
        pre_v, dist = nearest(pv, pre_reg)
        forward_delta = pv[post_fw] - pre_v[pre_fw]
        deltas.append((i, pv, pre_v, forward_delta, dist))

    forward_deltas = [d[3] for d in deltas]
    dists = [d[4] for d in deltas]

    print(f"\n=== Nearest-neighbor forward-axis delta (post minus pre), mm ===")
    sorted_fwd = sorted(forward_deltas)
    n = len(sorted_fwd)
    print(f"  min (most recessed vs pre): {sorted_fwd[0]*1000:.2f}")
    print(f"  median:                     {sorted_fwd[n//2]*1000:.2f}")
    print(f"  max (most protruding):      {sorted_fwd[-1]*1000:.2f}")
    recessed_3 = [d for d in forward_deltas if d < -0.003]
    recessed_10 = [d for d in forward_deltas if d < -0.010]
    recessed_20 = [d for d in forward_deltas if d < -0.020]
    print(f"  recessed >3mm vs pre:   {len(recessed_3):>4}")
    print(f"  recessed >10mm vs pre:  {len(recessed_10):>4}")
    print(f"  recessed >20mm vs pre:  {len(recessed_20):>4}")

    # Nearest-neighbor distance sanity — if large, meshes are very different scale/pose
    sorted_d = sorted(dists)
    print(f"\n  NN distance (mm): min={sorted_d[0]*1000:.2f}, median={sorted_d[n//2]*1000:.2f}, max={sorted_d[-1]*1000:.2f}")

    # List the 20 most-recessed verts with world coords
    print(f"\n=== 20 most-recessed post verts (forward delta sorted ascending) ===")
    sorted_deltas = sorted(deltas, key=lambda d: d[3])
    for rank, (i, pv, pre_v, fd, dist) in enumerate(sorted_deltas[:20]):
        print(f"  #{rank+1:2d} vidx={i:>5} world={tuple(round(c,3) for c in pv)} forward_delta={fd*1000:.2f}mm  nn_dist={dist*1000:.2f}mm")

    # Dump a JSON fix list for verts recessed >3mm — post vert index → target Z from nearest pre vert
    import json as _json
    fixes = []
    for i, pv, pre_v, fd, dist in deltas:
        if fd < -0.003 and dist < 0.025:  # recessed >3mm AND a plausible nearest-match (not a random distant vert)
            fixes.append({
                "idx": i,
                "current_pos": [round(c, 6) for c in pv],
                "target_z": round(pre_v[2], 6),
                "z_delta_mm": round((pre_v[2] - pv[2]) * 1000, 2),
                "nn_dist_mm": round(dist * 1000, 2),
            })
    out = ROOT / "scripts" / "breast-dent-fixes.json"
    out.write_text(_json.dumps({
        "source_pre_mesh": pre_name,
        "source_post_mesh": post_name,
        "count": len(fixes),
        "fixes": fixes,
    }, indent=2))
    print(f"\nWrote {len(fixes)} fix entries to {out}")


if __name__ == "__main__":
    sys.exit(main() or 0)
