"""Build 'Clawville Display' OTF from the AI glyph sheet (yellow fill only)."""
import numpy as np
from PIL import Image
import potrace
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

SHEET = r"C:\Users\itachi\AppData\Local\Temp\claude\C--Users-itachi-documents-crypto-clawville\fd807553-8b45-45c4-94d4-72dc83a1a561\scratchpad\glyphsheet-v1.png"
OUT = r"C:\Users\itachi\documents\crypto\clawville\branding\assets\fonts\ClawvilleDisplay.otf"
ROWS = ["ABCDEFG", "HIJKLMN", "OPQRSTU", "VWXYZ", "abcdefghi", "jklmnopqr", "stuvwxy", "012345678", "990"]
DESCENDERS = set("gjpqy")
UPM = 1000
CAP = 700

im = Image.open(SHEET).convert("RGB")
a = np.asarray(im).astype(int)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
mask = (r > 190) & (g > 150) & (b < 150)  # yellow fill only, excludes brown shadow + white bg

# --- row bands via horizontal projection
proj = mask.any(axis=1)
bands, in_band, s = [], False, 0
for y, v in enumerate(proj):
    if v and not in_band: in_band, s = True, y
    if not v and in_band:
        in_band = False
        if y - s > 20: bands.append((s, y))
if in_band: bands.append((s, len(proj)))
assert len(bands) >= len(ROWS), f"found {len(bands)} rows"
bands = bands[:len(ROWS)]

# --- per row: glyph segments via vertical projection
glyph_px = {}  # char -> (mask crop, row band)
for (y0, y1), rowstr in zip(bands, ROWS):
    row = mask[y0:y1]
    vproj = row.any(axis=0)
    segs, in_s, sx = [], False, 0
    for x, v in enumerate(vproj):
        if v and not in_s: in_s, sx = True, x
        if not v and in_s:
            in_s = False
            if x - sx > 8: segs.append((sx, x))
    if in_s: segs.append((sx, len(vproj)))
    # merge segments closer than 12px (broken strokes)
    merged = []
    for seg in segs:
        if merged and seg[0] - merged[-1][1] < 12:
            merged[-1] = (merged[-1][0], seg[1])
        else:
            merged.append(list(seg))
    # width-sanity pass: merge adjacent half-width fragments; split double-width blobs
    med = float(np.median([x1 - x0 for x0, x1 in merged]))
    i = 0
    while i < len(merged) - 1:
        w1 = merged[i][1] - merged[i][0]
        w2 = merged[i + 1][1] - merged[i + 1][0]
        gap = merged[i + 1][0] - merged[i][1]
        if w1 < 0.62 * med and w2 < 0.62 * med and gap < 14:
            merged[i:i + 2] = [[merged[i][0], merged[i + 1][1]]]
        else:
            i += 1
    colsum_full = row.sum(axis=0)
    out = []
    for x0, x1 in merged:
        if x1 - x0 > 1.65 * med:
            inner = colsum_full[x0 + 15:x1 - 15]
            cut = x0 + 15 + int(np.argmin(inner))
            out.extend([[x0, cut], [cut, x1]])
        else:
            out.append([x0, x1])
    merged = out
    # too few: split widest segment at its weakest internal column
    colsum = row.sum(axis=0)
    while len(merged) < len(rowstr):
        widths = [x1 - x0 for x0, x1 in merged]
        i = widths.index(max(widths))
        x0, x1 = merged[i]
        inner = colsum[x0 + 15:x1 - 15]
        cut = x0 + 15 + int(np.argmin(inner))
        merged[i:i + 1] = [[x0, cut], [cut, x1]]
        merged.sort()
    # too many: merge the adjacent pair whose merged width best matches the median width
    while len(merged) > len(rowstr):
        med = float(np.median([x1 - x0 for x0, x1 in merged]))
        best, best_err = 0, 1e9
        for i in range(len(merged) - 1):
            gap = merged[i + 1][0] - merged[i][1]
            if gap > 30:
                continue
            mw = merged[i + 1][1] - merged[i][0]
            err = abs(mw - med)
            if err < best_err:
                best, best_err = i, err
        merged[best:best + 2] = [[merged[best][0], merged[best + 1][1]]]
    assert len(merged) == len(rowstr), f"row '{rowstr}': {len(merged)} segs"
    for ch, (x0, x1) in zip(rowstr, merged):
        crop = mask[y0:y1, x0:x1]
        ys, xs = np.where(crop)
        crop = crop[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        glyph_px[ch] = crop

# --- vertical metrics from the pixel grid
capH_px = np.median([glyph_px[c].shape[0] for c in "AHINTE"])
xH_px = np.median([glyph_px[c].shape[0] for c in "acemnox" if c in glyph_px])
scale_u = CAP / capH_px          # uppercase + digits
scale_l = (CAP * 0.72) / xH_px   # lowercase: x-height = 504

def trace_to_pen(crop, pen, scale):
    h = crop.shape[0]
    bmp = potrace.Bitmap(np.logical_not(crop))  # bool dtype; potracer inverts internally (white=paper)
    path = bmp.trace(turdsize=8, alphamax=1.0, opttolerance=0.3)
    tpen = TransformPen(pen, Transform(scale, 0, 0, -scale, 0, h * scale))
    for curve in path:
        sp = curve.start_point
        tpen.moveTo((sp.x, sp.y))
        for seg in curve:
            if seg.is_corner:
                tpen.lineTo((seg.c.x, seg.c.y))
                tpen.lineTo((seg.end_point.x, seg.end_point.y))
            else:
                tpen.curveTo((seg.c1.x, seg.c1.y), (seg.c2.x, seg.c2.y),
                             (seg.end_point.x, seg.end_point.y))
        tpen.closePath()

def glyphname(ch):
    if ch.isdigit(): return "n" + ch
    return ("u_" if ch.isupper() else "l_") + ch.lower()

charstrings, metrics, cmap = {}, {}, {}
pen = T2CharStringPen(0, None)
charstrings[".notdef"] = pen.getCharString()
metrics[".notdef"] = (500, 0)

for ch, crop in glyph_px.items():
    is_lower = ch.islower()
    scale = scale_l if is_lower else scale_u
    h_px, w_px = crop.shape
    w = w_px * scale
    # baseline offset: descenders sit below baseline by ~35% of their height
    if ch in DESCENDERS:
        y_off = -0.34 * h_px * scale
    else:
        y_off = 0.0
    pen = T2CharStringPen(round(w + 80), None)
    tp = TransformPen(pen, Transform(1, 0, 0, 1, 40, y_off))
    trace_to_pen(crop, tp, scale)
    name = glyphname(ch)
    charstrings[name] = pen.getCharString()
    metrics[name] = (round(w + 80), 40)
    cmap[ord(ch)] = name

# synthesize lowercase z from Z at x-height scale
z_crop = glyph_px["Z"]
scale_z = (CAP * 0.72) / z_crop.shape[0]
w = z_crop.shape[1] * scale_z
pen = T2CharStringPen(round(w + 80), None)
tp = TransformPen(pen, Transform(1, 0, 0, 1, 40, 0))
trace_to_pen(z_crop, tp, scale_z)
charstrings["l_z"] = pen.getCharString()
metrics["l_z"] = (round(w + 80), 40)
cmap[ord("z")] = "l_z"

# space + basic punctuation as space-width blanks? just space.
pen = T2CharStringPen(320, None)
charstrings["space"] = pen.getCharString()
metrics["space"] = (320, 0)
cmap[0x20] = "space"

order = [".notdef", "space"] + [glyphname(c) for c in glyph_px] + ["l_z"]
fb = FontBuilder(UPM, isTTF=False)
fb.setupGlyphOrder(order)
fb.setupCharacterMap(cmap)
fb.setupCFF("ClawvilleDisplay", {"FullName": "Clawville Display", "FamilyName": "Clawville Display"}, charstrings, {})
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=880, descent=-260)
fb.setupNameTable({"familyName": "Clawville Display", "styleName": "Regular",
                   "fullName": "Clawville Display", "psName": "ClawvilleDisplay",
                   "version": "Version 1.0", "copyright": "ClawVille brand asset, generated 2026-07-27"})
fb.setupOS2(sTypoAscender=880, sTypoDescender=-260, usWinAscent=950, usWinDescent=300)
fb.setupPost()
fb.save(OUT)
print("saved", OUT)

# woff2 for web
from fontTools.ttLib import TTFont
f = TTFont(OUT)
f.flavor = "woff2"
f.save(OUT.replace(".otf", ".woff2"))
print("saved woff2")
