"""Render Clawville Display outlines as a reusable, fully vector sign.

Usage: python -B branding/scripts/render_sign_svg.py "TEXT" OUT.svg [--em 200] [--no-plank]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
import potrace
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from svgpathtools import parse_path

from wood import wood_plank


ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / "assets/fonts/ClawvilleDisplay.otf"


def color(rgb: tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % rgb


TOP, MID, BOT = map(color, ((255, 228, 110), (248, 208, 56), (238, 192, 48)))
RIM, HIL = map(color, ((216, 158, 34), (255, 246, 200)))
SHA, SHA2 = map(color, ((95, 50, 16), (60, 30, 8)))


def glyph_paths(text: str, em: int) -> tuple[str, int, int, float, float]:
    font = TTFont(FONT)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    advance = font["hmtx"].metrics
    scale = em / font["head"].unitsPerEm
    selected = []
    cursor = 0
    bounds = []
    previous = ""
    for char in text:
        name = "v.claw" if previous + char in ("wv", "Wv", "WV") else cmap.get(ord(char))
        if name is None:
            raise ValueError(f"The display font has no glyph for {char!r}")
        pen = BoundsPen(glyphs)
        glyphs[name].draw(pen)
        if pen.bounds:
            x0, y0, x1, y1 = pen.bounds
            bounds.append((cursor + x0, y0, cursor + x1, y1))
        selected.append((name, cursor))
        cursor += advance[name][0]
        previous = char
    if not bounds:
        raise ValueError("Text has no visible glyphs")
    left = min(b[0] for b in bounds)
    right = max(b[2] for b in bounds)
    top = max(b[3] for b in bounds)
    bottom = min(b[1] for b in bounds)
    pad = em * .68
    width = int(np.ceil((right - left) * scale + 2 * pad))
    height = int(np.ceil((top - bottom) * scale + 2 * pad))
    baseline = pad + top * scale
    result = []
    for name, offset in selected:
        pen = SVGPathPen(glyphs)
        transformed = TransformPen(pen, (scale, 0, 0, -scale,
                                         pad + (offset - left) * scale, baseline))
        glyphs[name].draw(transformed)
        if pen.getCommands():
            result.append(pen.getCommands())
    return " ".join(result), width, height, pad, baseline


def glyph_mask(path: str, width: int, height: int) -> np.ndarray:
    contours = []
    for subpath in parse_path(path).continuous_subpaths():
        points = []
        for segment in subpath:
            steps = max(2, int(np.ceil(segment.length(error=0.1) / 1.5)))
            points.extend((segment.point(i / steps).real, segment.point(i / steps).imag)
                          for i in range(steps))
        if points:
            contours.append(np.rint(points).astype(np.int32))
    mask = np.zeros((height, width), np.uint8)
    cv2.fillPoly(mask, contours, 255)
    return mask


def plank_path(mask: np.ndarray, em: int) -> tuple[str, tuple[int, int, int, int]]:
    radius = max(3, round(em * .17))
    close_radius = max(3, round(em * .36))
    kernel = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*r+1, 2*r+1))
    shape = cv2.dilate(mask, kernel(radius))
    shape = cv2.morphologyEx(shape, cv2.MORPH_CLOSE, kernel(close_radius))
    shape = (cv2.GaussianBlur(shape, (0, 0), em * .045) >= 100).astype(np.uint8)
    # The installed potrace binding inverts its bitmap, so pass inverse booleans.
    paths = potrace.Bitmap(~shape.astype(bool)).trace(turdsize=20, alphamax=1.1, opticurve=True,
                                        opttolerance=.35)
    if not paths:
        raise ValueError("Could not trace the plank")
    commands = []
    for contour in paths:
        start = contour.start_point
        commands.append(f"M{start.x:.2f} {start.y:.2f}")
        for segment in contour:
            if segment.is_corner:
                commands.append(f"L{segment.c.x:.2f} {segment.c.y:.2f} L{segment.end_point.x:.2f} {segment.end_point.y:.2f}")
            else:
                commands.append(f"C{segment.c1.x:.2f} {segment.c1.y:.2f} {segment.c2.x:.2f} {segment.c2.y:.2f} {segment.end_point.x:.2f} {segment.end_point.y:.2f}")
        commands.append("Z")
    ys, xs = np.nonzero(shape)
    return " ".join(commands), (int(xs.min()), int(ys.min()), int(xs.max()+1), int(ys.max()+1))


def render(text: str, output: Path, em: int, with_plank: bool) -> None:
    if em < 20:
        raise ValueError("--em must be at least 20")
    letters, width, height, _, _ = glyph_paths(text, em)
    margin = max(5, round(em * .05))
    wood = ""
    wood_defs = ""
    if with_plank:
        plank, (x0, y0, x1, y1) = plank_path(glyph_mask(letters, width, height), em)
        wood_defs, wood_group = wood_plank(plank, (x0, y0, x1, y1), "sign")
        wood = f'''<use href="#plank" transform="translate({em*.01:.3f} {em*.025:.3f})" fill="#3c1e0e" opacity=".42" filter="url(#woodShadow)"/>
{wood_group}'''
        view = (max(0, x0-margin), max(0, y0-margin), min(width, x1+margin), min(height, y1+margin))
    else:
        plank = ""
        view = (0, 0, width, height)
    x0, y0, x1, y1 = view
    defs = f'''<defs>
<path id="letters" d="{letters}"/>
<path id="plank" d="{plank}"/>
<linearGradient id="face" x2="0" y2="1"><stop stop-color="{TOP}"/><stop offset=".18" stop-color="{MID}"/><stop offset="1" stop-color="{BOT}"/></linearGradient>
{wood_defs}
<filter id="woodShadow" x="-10%" y="-20%" width="120%" height="150%"><feGaussianBlur stdDeviation="{em*.02:.3f}"/></filter>
<clipPath id="letterClip"><use href="#letters"/></clipPath>
<mask id="topEdge"><use href="#letters" fill="white"/><use href="#letters" transform="translate(0 {em*.06:.3f})" fill="black"/></mask>
</defs>'''
    body = f'''{wood}
<use href="#letters" transform="translate({em*.055:.3f} {em*.09:.3f})" fill="{SHA2}"/>
<use href="#letters" transform="translate({em*.045:.3f} {em*.075:.3f})" fill="{SHA}"/>
<use href="#letters" fill="url(#face)"/>
<use href="#letters" fill="none" stroke="{RIM}" stroke-width="{em*.052:.3f}" clip-path="url(#letterClip)"/>
<use href="#letters" fill="{HIL}" opacity=".45" mask="url(#topEdge)" clip-path="url(#letterClip)"/>'''
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{x1-x0}" height="{y1-y0}" viewBox="{x0} {y0} {x1-x0} {y1-y0}">\n{defs}\n{body}\n</svg>\n'
    data = svg.encode("utf-8")
    if with_plank and text == "Clawville" and len(data) > 250_000:
        raise ValueError(f"Clawville SVG exceeds 250 KB: {len(data)} bytes")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    print(f"{output}: {len(data)} bytes, {x1-x0}x{y1-y0}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text")
    parser.add_argument("output", type=Path)
    parser.add_argument("--em", type=int, default=200)
    parser.add_argument("--no-plank", action="store_true")
    args = parser.parse_args()
    render(args.text, args.output, args.em, not args.no_plank)


if __name__ == "__main__":
    main()
