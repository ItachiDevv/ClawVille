"""Build 'Clawville Display' v2 OTF from three gpt-image-2 glyph sheets."""
import numpy as np
from PIL import Image
import potrace
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

import os
SCRATCH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "glyphsheets")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ClawvilleDisplay.otf")
SHEETS = [
    (SCRATCH + r"\upper.png", ["ABCDEFGHIJKLM", "NOPQRSTUVWXYZ"]),
    (SCRATCH + r"\lower.png", ["abcdefghijklm", "nopqrstuvwxyz"]),
    (SCRATCH + r"\digits.png", ["0123456789"]),
]
DESCENDERS = set("fgjpqy")
UPM = 1000
CAP = 700

def sheet_mask(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (r > 150) & (r >= g) & (g > b) & ((r - b) > 55)

def find_rows(mask):
    proj = mask.any(axis=1)
    bands, in_b, s = [], False, 0
    for y, v in enumerate(proj):
        if v and not in_b: in_b, s = True, y
        if not v and in_b:
            in_b = False
            if y - s > 40: bands.append((s, y))
    if in_b: bands.append((s, len(proj)))
    return bands

def segment_row(row, expected):
    vproj = row.any(axis=0)
    segs, in_s, sx = [], False, 0
    for x, v in enumerate(vproj):
        if v and not in_s: in_s, sx = True, x
        if not v and in_s:
            in_s = False
            if x - sx > 10: segs.append([sx, x])
    if in_s: segs.append([sx, len(vproj)])
    merged = []
    for seg in segs:
        if merged and seg[0] - merged[-1][1] < 14:
            merged[-1][1] = seg[1]
        else:
            merged.append(seg)
    # absorb floating dots (i/j dots offset by tilt) + tiny specks into nearest neighbor
    H = row.shape[0]
    areas = [row[:, x0:x1].sum() for x0, x1 in merged]
    med_area = float(np.median(areas))
    changed = True
    while changed and len(merged) > expected:
        changed = False
        for i, (x0, x1) in enumerate(merged):
            sub = row[:, x0:x1]
            ys = np.where(sub.any(axis=1))[0]
            floating = ys.max() < 0.55 * H and (ys.max() - ys.min()) < 0.4 * H
            tiny = sub.sum() < 0.06 * med_area
            if floating or tiny:
                gl = x0 - merged[i - 1][1] if i > 0 else 10**9
                gr = merged[i + 1][0] - x1 if i < len(merged) - 1 else 10**9
                j = i - 1 if gl <= gr else i + 1
                lo, hi = min(i, j), max(i, j)
                merged[lo:hi + 1] = [[merged[lo][0], merged[hi][1]]]
                changed = True
                break
    colsum = row.sum(axis=0)
    while len(merged) < expected:
        widths = [x1 - x0 for x0, x1 in merged]
        i = widths.index(max(widths))
        x0, x1 = merged[i]
        inner = colsum[x0 + 20:x1 - 20]
        cut = x0 + 20 + int(np.argmin(inner))
        merged[i:i + 1] = [[x0, cut], [cut, x1]]
    while len(merged) > expected:
        gaps = [merged[i + 1][0] - merged[i][1] for i in range(len(merged) - 1)]
        i = gaps.index(min(gaps))
        merged[i:i + 2] = [[merged[i][0], merged[i + 1][1]]]
    return merged

from scipy import ndimage

def row_glyphs(row, expected):
    """Component-based segmentation: cores sorted by x, satellites (dots) attached to nearest core."""
    lab, n = ndimage.label(row, structure=np.ones((3, 3), int))
    comps = []
    for i in range(1, n + 1):
        m = lab == i
        area = int(m.sum())
        ys, xs = np.where(m)
        comps.append({"m": m, "area": area, "cx": xs.mean(), "cy": ys.mean()})
    comps = [c for c in comps if c["area"] >= 25]  # drop noise specks before any classification
    med = float(np.median([c["area"] for c in comps]))
    cores = [c for c in comps if c["area"] >= 0.25 * med]
    sats = [c for c in comps if c["area"] < 0.25 * med]
    # too many cores: merge smallest core into its nearest core by x (broken stroke)
    while len(cores) > expected:
        cores.sort(key=lambda c: c["area"])
        small = cores.pop(0)
        near = min(cores, key=lambda c: abs(c["cx"] - small["cx"]))
        near["m"] = near["m"] | small["m"]
        near["area"] += small["area"]
    assert len(cores) == expected, f"cores {len(cores)} != {expected}"
    cores.sort(key=lambda c: c["cx"])
    for s in sats:
        near = min(cores, key=lambda c: (c["cx"] - s["cx"]) ** 2 + (c["cy"] - s["cy"]) ** 2)
        xs_c = np.where(near["m"].any(axis=0))[0]
        core_w = xs_c.max() - xs_c.min() + 1
        if abs(s["cx"] - near["cx"]) < 0.9 * core_w and s["area"] > 40:
            near["m"] = near["m"] | s["m"]
    out = []
    for c in cores:
        ys, xs = np.where(c["m"])
        out.append(c["m"][ys.min():ys.max() + 1, xs.min():xs.max() + 1])
    return out

glyph_px = {}
for path, rows in SHEETS:
    mask = sheet_mask(path)
    bands = find_rows(mask)
    assert len(bands) >= len(rows), f"{path}: {len(bands)} bands"
    for (y0, y1), rowstr in zip(bands[:len(rows)], rows):
        row = mask[y0:y1]
        for ch, crop in zip(rowstr, row_glyphs(row, len(rowstr))):
            glyph_px[ch] = crop

missing = [c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" if c not in glyph_px]
assert not missing, f"missing {missing}"

capH = np.median([glyph_px[c].shape[0] for c in "AHINTE"])
xH = np.median([glyph_px[c].shape[0] for c in "acemnox"])
scale_u = CAP / capH
scale_l = (CAP * 0.74) / xH

def trace_to_pen(crop, pen, scale):
    h = crop.shape[0]
    bmp = potrace.Bitmap(np.logical_not(crop))
    path = bmp.trace(turdsize=10, alphamax=1.0, opttolerance=0.3)
    tpen = TransformPen(pen, Transform(scale, 0, 0, -scale, 0, h * scale))
    for curve in path:
        sp = curve.start_point
        tpen.moveTo((sp.x, sp.y))
        for seg in curve:
            if seg.is_corner:
                tpen.lineTo((seg.c.x, seg.c.y))
                tpen.lineTo((seg.end_point.x, seg.end_point.y))
            else:
                tpen.curveTo((seg.c1.x, seg.c1.y), (seg.c2.x, seg.c2.y), (seg.end_point.x, seg.end_point.y))
        tpen.closePath()

def glyphname(ch):
    if ch.isdigit(): return "n" + ch
    return ("u_" if ch.isupper() else "l_") + ch.lower()

charstrings, metrics, cmap = {}, {}, {}
pen = T2CharStringPen(0, None)
charstrings[".notdef"] = pen.getCharString()
metrics[".notdef"] = (500, 0)

for ch, crop in glyph_px.items():
    scale = scale_l if ch.islower() else scale_u
    h_px, w_px = crop.shape
    w = w_px * scale
    y_off = -0.32 * h_px * scale if ch in DESCENDERS else 0.0
    pen = T2CharStringPen(round(w + 70), None)
    tp = TransformPen(pen, Transform(1, 0, 0, 1, 35, y_off))
    trace_to_pen(crop, tp, scale)
    name = glyphname(ch)
    charstrings[name] = pen.getCharString()
    metrics[name] = (round(w + 70), 35)
    cmap[ord(ch)] = name

pen = T2CharStringPen(320, None)
charstrings["space"] = pen.getCharString()
metrics["space"] = (320, 0)
cmap[0x20] = "space"

order = [".notdef", "space"] + [glyphname(c) for c in glyph_px]
fb = FontBuilder(UPM, isTTF=False)
fb.setupGlyphOrder(order)
fb.setupCharacterMap(cmap)
fb.setupCFF("ClawvilleDisplay", {"FullName": "Clawville Display", "FamilyName": "Clawville Display"}, charstrings, {})
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=900, descent=-280)
fb.setupNameTable({"familyName": "Clawville Display", "styleName": "Regular",
                   "fullName": "Clawville Display", "psName": "ClawvilleDisplay",
                   "version": "Version 3.0", "copyright": "ClawVille brand asset, generated 2026-07-27"})
fb.setupOS2(sTypoAscender=900, sTypoDescender=-280, usWinAscent=980, usWinDescent=320)
fb.setupPost()
fb.save(OUT)
from fontTools.ttLib import TTFont
f = TTFont(OUT)
f.flavor = "woff2"
f.save(OUT.replace(".otf", ".woff2"))
print("saved v2 otf + woff2")
