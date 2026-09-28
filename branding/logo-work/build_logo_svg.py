"""Build and compare two ClawVille wood-sign SVG candidates.

Run `python branding/logo-work/build_logo_svg.py` from any directory. The script
reads the three canonical logo assets. It keys the opaque large PNG with a
color-derived silhouette, fits the original mono path to the reference yellow
mask, traces the reference alpha for a compact plank, and writes a textured
constructed SVG. It then traces a reduced-color copy of the keyed raster with
vtracer, renders all sizes in headless Chrome, measures masks and RGB error,
and writes a static comparison page and report. The keyed PNG goes to
assets/logos; the other results stay in logo-work.
No font, network service, random unseeded input, or embedded bitmap is used.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.optimize import differential_evolution, minimize
import vtracer


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "assets" / "logos"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
W, H = 1000, 334
SIZES = (32, 64, 120, 200, 600)


def svg_path_data() -> str:
    root = ET.parse(SOURCE / "clawville-wordmark-mono.svg").getroot()
    paths = [node.attrib["d"] for node in root.iter() if node.tag.endswith("path")]
    assert len(paths) == 1, "Expected one canonical compound wordmark path"
    return paths[0]


def chrome_render(svg: Path, width: int, output: Path, *, height: int | None = None) -> None:
    """Render the SVG at native requested CSS size, then crop the Chrome canvas."""
    height = height or round(width * H / W)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cv-logo-") as temp:
        temp_path = Path(temp)
        html = temp_path / "render.html"
        shot = temp_path / "shot.png"
        uri = svg.resolve().as_uri()
        html.write_text(
            f'<!doctype html><html><style>html,body{{margin:0;background:transparent}}'
            f'img{{display:block;width:{width}px;height:{height}px}}</style>'
            f'<img src="{uri}"></html>', encoding="utf-8"
        )
        cmd = [str(CHROME), "--headless=new", "--disable-gpu", "--no-first-run",
               "--no-default-browser-check", "--disable-extensions",
               "--default-background-color=00000000", f"--screenshot={shot}",
               f"--window-size={max(1000, width)},{max(600, height + 120)}",
               html.as_uri()]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        except subprocess.TimeoutExpired as exc:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(exc.pid)],
                           capture_output=True, check=False) if getattr(exc, "pid", None) else None
            raise
        if proc.returncode or not shot.exists():
            raise RuntimeError(f"Chrome render failed: {proc.stderr[-1000:]}")
        image = Image.open(shot).convert("RGBA")
        if image.width < width or image.height < height:
            raise RuntimeError(f"Chrome screenshot too small: {image.size}")
        image.crop((0, 0, width, height)).save(output)


def reference_masks(reference: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rgb = reference[:, :, :3]
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    yellow = ((hsv[:, :, 0] >= 16) & (hsv[:, :, 0] <= 37) &
              (hsv[:, :, 1] > 135) & (hsv[:, :, 2] > 175) &
              (reference[:, :, 3] >= 128))
    return yellow.astype(np.uint8), (reference[:, :, 3] >= 128).astype(np.uint8)


def fit_wordmark(path_data: str, target: np.ndarray) -> tuple[float, float, float, float, float, float, float]:
    base = HERE / "renders" / "_wordmark-fit-source.svg"
    base.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="334" '
        f'viewBox="0 0 1000 334"><path d="{path_data}" transform="scale(4)" '
        f'fill="#ffffff"/></svg>', encoding="utf-8"
    )
    base_png = HERE / "renders" / "_wordmark-fit-source.png"
    chrome_render(base, W, base_png)
    source = (np.asarray(Image.open(base_png).convert("RGBA"))[:, :, 3] >= 128).astype(np.uint8)
    base.unlink()
    base_png.unlink()
    # The canonical path occupies about 800 by 197 pixels after scale(4).
    # Affine fit permits small size and registration differences without edits.
    def warp(v: np.ndarray, size: tuple[int, int] = (W, H)) -> np.ndarray:
        sx, sy, tx, ty = v[:4]
        hx, hy = v[4:] if len(v) > 4 else (0, 0)
        matrix = np.array([[sx, hx, tx], [hy, sy, ty]], dtype=np.float32)
        return cv2.warpAffine(source, matrix, size, flags=cv2.INTER_NEAREST)

    target_small = cv2.resize(target, (500, 167), interpolation=cv2.INTER_NEAREST)

    def loss(v: np.ndarray) -> float:
        candidate = cv2.resize(warp(v), (500, 167), interpolation=cv2.INTER_NEAREST)
        intersection = np.count_nonzero(candidate & target_small)
        union = np.count_nonzero(candidate | target_small)
        return 1 - intersection / max(1, union)

    result = differential_evolution(loss, [(1.02, 1.23), (0.99, 1.18), (30, 95), (48, 98)],
                                    seed=13, popsize=10, maxiter=55, polish=False, workers=1)
    def full_loss(v: np.ndarray) -> float:
        candidate = warp(v)
        intersection = np.count_nonzero(candidate & target)
        union = np.count_nonzero(candidate | target)
        return 1 - intersection / max(1, union)

    affine = np.r_[result.x, 0.0, 0.0]
    result = differential_evolution(loss, [(affine[0]-.01, affine[0]+.01),
                                           (affine[1]-.01, affine[1]+.01),
                                           (affine[2]-2, affine[2]+2),
                                           (affine[3]-2, affine[3]+2),
                                           (-.025, .025), (-.012, .012)],
                                    seed=17, popsize=8, maxiter=36, polish=False)
    result = minimize(full_loss, result.x, method="Nelder-Mead",
                      options={"maxiter": 300, "xatol": 0.0001})
    sx, sy, tx, ty, hx, hy = result.x
    matched = warp(result.x)
    iou = np.count_nonzero(matched & target) / max(1, np.count_nonzero(matched | target))
    # SVG transform operates on source coordinates; the base raster used scale(4).
    return sx * 4, sy * 4, tx, ty, hx * 4, hy * 4, iou


def contour_path(mask: np.ndarray, epsilon: float = 1.5) -> tuple[str, int]:
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(contour, epsilon, True)[:, 0, :].astype(float)
    # A closed Catmull-Rom chain gives a smooth outline with few control points.
    n = len(approx)
    chunks = [f"M{approx[0, 0]:.1f} {approx[0, 1]:.1f}"]
    for i in range(n):
        p0, p1, p2, p3 = (approx[(i + offset) % n] for offset in (-1, 0, 1, 2))
        c1 = p1 + (p2 - p0) / 6
        c2 = p2 - (p3 - p1) / 6
        chunks.append(f"C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}")
    return " ".join(chunks) + "Z", n


def constructed_svg(path_data: str, plank: str, fit: tuple[float, float, float, float, float, float, float]) -> str:
    sx, sy, tx, ty, hx, hy, _ = fit
    transform = f"matrix({sx:.5f} {hy:.5f} {hx:.5f} {sy:.5f} {tx:.3f} {ty:.3f})"
    rng = np.random.default_rng(2727)
    grains = []
    # Short, broken fibers track the real plank's horizontal grain.
    for _ in range(330):
        x = rng.uniform(28, 950)
        y = rng.uniform(39, 308)
        length = rng.uniform(8, 100)
        dy = rng.uniform(-3.5, 3.5)
        color = "#e4a066" if rng.random() < 0.43 else "#4a210e"
        opacity = rng.uniform(0.10, 0.34)
        stroke = rng.uniform(0.45, 1.45)
        grains.append(f'<path d="M{x:.1f} {y:.1f}q{length/2:.1f} {dy:.1f} {length:.1f} 0" '
                      f'stroke="{color}" stroke-width="{stroke:.1f}" opacity="{opacity:.2f}"/>')
    grain = "\n".join(grains)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="334" viewBox="0 0 1000 334">
<defs>
  <linearGradient id="wood" x2="0" y2="1"><stop stop-color="#b66d36"/><stop offset=".28" stop-color="#965025"/><stop offset=".68" stop-color="#8a4a20"/><stop offset="1" stop-color="#6c3418"/></linearGradient>
  <linearGradient id="gold" x2="0" y2="1"><stop stop-color="#ffe46e"/><stop offset=".18" stop-color="#f8d038"/><stop offset="1" stop-color="#eec030"/></linearGradient>
  <clipPath id="plankClip"><path d="{plank}"/></clipPath>
  <filter id="woodShadow" x="-10%" y="-20%" width="120%" height="150%"><feGaussianBlur stdDeviation="4"/></filter>
</defs>
<path d="{plank}" transform="translate(2 5)" fill="#3c1e0e" opacity=".42" filter="url(#woodShadow)"/>
<path d="{plank}" fill="url(#wood)" stroke="#5c2c13" stroke-width="2.1"/>
<g clip-path="url(#plankClip)" fill="none" stroke-linecap="round">{grain}</g>
<path d="{plank}" fill="none" stroke="#de9758" stroke-width="1.6" opacity=".55"/>
<g transform="{transform}">
 <path d="{path_data}" transform="translate(1.9 2.5)" fill="#3c1e08" opacity=".75"/>
 <path d="{path_data}" transform="translate(1.0 1.3)" fill="#5f3210"/>
 <path d="{path_data}" fill="url(#gold)"/>
 <path d="{path_data}" fill="none" stroke="#d89e22" stroke-width=".045"/>
 <path d="{path_data}" fill="none" stroke="#fff6c8" stroke-width=".16" opacity=".36" transform="translate(0 -.17)"/>
</g>
</svg>'''


def keyed_large() -> np.ndarray:
    original = np.asarray(Image.open(SOURCE / "clawville-logo-wood-large.png").convert("RGB"))
    hsv = cv2.cvtColor(original, cv2.COLOR_RGB2HSV)
    saturated = (hsv[:, :, 1] > 17).astype(np.uint8)
    saturated = cv2.morphologyEx(saturated, cv2.MORPH_CLOSE,
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    contours, _ = cv2.findContours(saturated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    largest = max(contours, key=cv2.contourArea)
    mask = np.zeros(saturated.shape, np.uint8)
    cv2.drawContours(mask, [largest], -1, 255, -1)
    # Preserve all original RGB samples. Only edge alpha is antialiased.
    mask = cv2.GaussianBlur(mask, (3, 3), 0.65)
    rgba = np.dstack((original, mask))
    Image.fromarray(rgba, "RGBA").save(SOURCE / "clawville-logo-wood-large-transparent.png")
    return rgba


def trace_candidate_b(keyed: np.ndarray) -> None:
    # Reduce source dimensions and color resolution before trace. This keeps
    # visible wood texture while avoiding a huge path for every grain pixel.
    resized = cv2.resize(keyed, (600, 200), interpolation=cv2.INTER_AREA)
    rgb = resized[:, :, :3].copy()
    alpha = resized[:, :, 3]
    rgb[alpha < 32] = 0
    rgb = cv2.bilateralFilter(rgb, 3, 18, 5)
    # Uniform channel bins keep the logo's gradient and surface variation.
    rgb = np.uint8(np.clip(np.round(rgb.astype(np.float32) / 10) * 10, 0, 255))
    rgba = np.dstack((rgb, alpha))
    with tempfile.TemporaryDirectory(prefix="cv-trace-") as temp:
        source = Path(temp) / "trace-input.png"
        out = Path(temp) / "trace.svg"
        Image.fromarray(rgba, "RGBA").save(source)
        vtracer.convert_image_to_svg_py(str(source), str(out), colormode="color",
                                        hierarchical="stacked", mode="spline",
                                        filter_speckle=6, color_precision=5,
                                        layer_difference=10, corner_threshold=60,
                                        length_threshold=4, max_iterations=8,
                                        splice_threshold=45, path_precision=1)
        data = out.read_text(encoding="utf-8")
    # The keyed high-resolution source is 1792x576; the trace is 600x200.
    # Render it into the reference's exact 1000x334 canvas.
    data = re.sub(r'<svg\b[^>]*>', '<svg xmlns="http://www.w3.org/2000/svg" '
                  'width="1000" height="334" viewBox="0 0 600 200" '
                  'preserveAspectRatio="none">', data, count=1)
    (HERE / "candidate-b-traced.svg").write_text(data, encoding="utf-8")


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.count_nonzero(a & b) / max(1, np.count_nonzero(a | b)))


def metrics(reference: np.ndarray, letter: np.ndarray, silhouette: np.ndarray) -> dict:
    output = {}
    for key, file in (("A", "candidate-a-constructed.svg"), ("B", "candidate-b-traced.svg")):
        image = np.asarray(Image.open(HERE / "renders" / f"{key.lower()}-1000.png").convert("RGBA"))
        candidate_letter, candidate_silhouette = reference_masks(image)
        inside = silhouette.astype(bool)
        error = np.abs(image[:, :, :3].astype(np.int16) - reference[:, :, :3].astype(np.int16))
        data = (HERE / file).read_bytes()
        output[key] = {
            "file_bytes": len(data),
            "path_count": len(re.findall(rb"<path\b", data)),
            "letter_mask_iou": round(iou(letter, candidate_letter), 4),
            "silhouette_iou": round(iou(silhouette, candidate_silhouette), 4),
            "mean_abs_rgb_error": round(float(error[inside].mean()), 2),
        }
    return output


def comparison_html(data: dict) -> str:
    cards = []
    for title, image, prefix in (("Reference", "renders/reference-1000.png", "reference"),
                                 ("A · Constructed", "renders/a-1000.png", "a"),
                                 ("B · Traced", "renders/b-1000.png", "b")):
        ladder = "".join(
            f'<div><img src="{image if prefix == "reference" else f"renders/{prefix}-{n}.png"}" width="{n}" alt="{title} at {n}px"><small>{n}px</small></div>'
            for n in SIZES)
        cards.append(f'<article><h2>{title}</h2><img class="hero" src="{image}" alt="{title}">'
                     f'<div class="ladder">{ladder}</div></article>')
    rows = "".join(f'<tr><th>{key}</th><td>{v["file_bytes"]:,}</td><td>{v["path_count"]:,}</td>'
                   f'<td>{v["letter_mask_iou"]:.4f}</td><td>{v["silhouette_iou"]:.4f}</td>'
                   f'<td>{v["mean_abs_rgb_error"]:.2f}</td></tr>' for key, v in data.items() if key in ("A", "B"))
    panels = "".join(f'<section style="--surface:{color}"><h2>{name}</h2><div class="grid">'
                     + "".join(cards) + "</div></section>" for name, color in
                     (("Dark", "#061520"), ("Light", "#ffffff"), ("Sky", "#D8E8E0")))
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawVille wood-sign SVG comparison</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#17242b;color:#f5f1e6;font:15px system-ui,sans-serif}}header,main{{max-width:1440px;margin:auto;padding:24px}}h1{{margin:0 0 6px}}p{{margin:0 0 24px}}section{{background:var(--surface);color:#17242b;border-radius:14px;padding:16px;margin:20px 0}}section:first-child{{color:white}}.grid{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}}article{{min-width:0;padding:12px;border:1px solid #80808040;border-radius:10px}}article h2{{font-size:16px;margin:0 0 12px}}.hero{{width:100%;height:auto;aspect-ratio:1000/334;object-fit:contain}}.ladder{{display:flex;align-items:end;gap:12px;flex-wrap:wrap;min-height:210px}}.ladder div{{display:flex;flex-direction:column;gap:8px;align-items:start}}.ladder img{{height:auto;max-width:100%}}small{{opacity:.75}}table{{border-collapse:collapse;width:100%;margin:24px 0}}td,th{{padding:10px;border:1px solid #819099;text-align:right}}th:first-child{{text-align:left}}@media(max-width:850px){{.grid{{grid-template-columns:1fr}}}}
</style><header><h1>ClawVille wood-sign candidates</h1><p>Reference image, constructed vector, and traced vector. All artwork uses the source logo geometry.</p></header><main>{panels}<h2>Measurements at 1000 px</h2><table><thead><tr><th>Candidate</th><th>Bytes</th><th>Paths</th><th>Letter IoU</th><th>Silhouette IoU</th><th>Mean RGB error</th></tr></thead><tbody>{rows}</tbody></table></main></html>'''


def main() -> None:
    (HERE / "renders").mkdir(parents=True, exist_ok=True)
    reference_image = Image.open(SOURCE / "clawville-logo-transparent.png").convert("RGBA")
    assert reference_image.size == (W, H)
    reference_image.save(HERE / "renders" / "reference-1000.png")
    reference = np.asarray(reference_image)
    letter, silhouette = reference_masks(reference)
    wordmark = svg_path_data()
    fit = fit_wordmark(wordmark, letter)
    plank, nodes = contour_path(silhouette)
    (HERE / "candidate-a-constructed.svg").write_text(constructed_svg(wordmark, plank, fit), encoding="utf-8")
    keyed = keyed_large()
    trace_candidate_b(keyed)
    for key, file in (("a", "candidate-a-constructed.svg"), ("b", "candidate-b-traced.svg")):
        for n in (1000, *SIZES):
            chrome_render(HERE / file, n, HERE / "renders" / f"{key}-{n}.png")
    results = metrics(reference, letter, silhouette)
    results["construction"] = {"wordmark_fit_iou": round(fit[-1], 4),
                                "wordmark_svg_transform": [round(x, 5) for x in fit[:6]],
                                "plank_outline_nodes": nodes,
                                "keyed_edge_method": "Largest saturation component; filled interior; 3x3 Gaussian antialias on alpha only; original RGB preserved."}
    (HERE / "metrics.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    (HERE / "compare.html").write_text(comparison_html(results), encoding="utf-8")
    a, b = results["A"], results["B"]
    report = f"""# ClawVille wood-sign SVG comparison

Run `python branding/logo-work/build_logo_svg.py` to rebuild every output from the canonical logo sources.

## Files

- `build_logo_svg.py`: deterministic builder, render loop, and measurement code.
- `candidate-a-constructed.svg`: source path letters, traced plank outline, vector gradients, grain, rim, and offset shadow.
- `candidate-b-traced.svg`: full-color vtracer output from the keyed large sign.
- `assets/logos/clawville-logo-wood-large-transparent.png`: 1792×576 large sign with real alpha.
- `renders/`: reference at 1000 px, plus A and B at 32, 64, 120, 200, 600, and 1000 px.
- `metrics.json`: reproducible mask and RGB measurements.
- `compare.html`: static dark, light, and sky comparison.

## Metrics at 1000 px

| Candidate | File bytes | Paths | Letter-mask IoU | Silhouette IoU | Mean absolute RGB error |
|---|---:|---:|---:|---:|---:|
| A | {a['file_bytes']:,} | {a['path_count']} | {a['letter_mask_iou']:.4f} | {a['silhouette_iou']:.4f} | {a['mean_abs_rgb_error']:.2f} |
| B | {b['file_bytes']:,} | {b['path_count']} | {b['letter_mask_iou']:.4f} | {b['silhouette_iou']:.4f} | {b['mean_abs_rgb_error']:.2f} |

The letter mask uses HSV hue 16–37, saturation above 135, value above 175, and alpha at least 128. The silhouette mask uses alpha at least 128. Mean RGB error includes all pixels inside the reference silhouette.

## Differences and limits

- A keeps the original mono path letter geometry. Its fitted path mask reaches {results['construction']['wordmark_fit_iou']:.4f} IoU. Its final rendered yellow mask reaches {a['letter_mask_iou']:.4f}; this misses the 0.95 rendered target by {max(0, .95-a['letter_mask_iou']):.4f}.
- A has a smooth wood gradient and sparse vector grain. It omits the reference's dense photographic grain.
- B keeps more source color variation, but its 600 px trace input and speckle filter make the grain coarse. Its outer edge and letter registration differ from the reference.
- The large PNG has a baked checkerboard. The key uses the largest saturated connected shape, fills its interior, and blurs only alpha across a 3×3 edge. All RGB pixels remain byte-identical to the large source, including edge RGB pixels. The key excludes the gray outside area and some neutral soft shadow pixels.
- Both SVGs contain paths and gradients only. Neither SVG embeds a raster image.
"""
    (HERE / "report.md").write_text(report, encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
