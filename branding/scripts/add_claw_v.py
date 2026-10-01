"""Add the canonical logo claw as a contextual alternate to ClawvilleDisplay.

Run from the repository root: python branding/scripts/add_claw_v.py
The script refuses an input that already contains v.claw.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
from pathlib import Path

from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont
from svgpathtools import CubicBezier, Line, QuadraticBezier, parse_path


ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / "assets/fonts/ClawvilleDisplay.otf"
SVG = ROOT / "assets/logos/clawville-wordmark-mono.svg"
VERSION_NOTE = "claw-v 2026-09-29"


def source_contours():
    root = ET.parse(SVG).getroot()
    paths = [node.attrib["d"] for node in root.iter() if node.tag.endswith("path")]
    if len(paths) != 1:
        raise ValueError("Expected one compound wordmark path")
    contours = parse_path(paths[0]).continuous_subpaths()
    claw = [path for path in contours if 99 <= path.bbox()[0] and path.bbox()[1] <= 133]
    if len(claw) != 2:
        raise ValueError(f"Expected two claw contours, found {len(claw)}")
    return claw


def build(font_path: Path) -> None:
    font = TTFont(font_path, recalcTimestamp=False)
    if "v.claw" in font.getGlyphOrder() or 0xE000 in font.getBestCmap():
        raise ValueError("This font already contains v.claw or U+E000")
    if "CFF " not in font or "GSUB" in font:
        raise ValueError("Expected the locked CFF font without GSUB")
    # Load hmtx before the glyph count changes. Its reader uses that count.
    font["hmtx"]

    # Mono logo a: y=14.68..39.42. Font a: y=0..536.7.
    # This puts the claw top near 663, below the l ascender at 740.
    # Its 9.74 logo-unit descent becomes a 211 font-unit descent.
    scale = 536.7 / (39.42 - 14.68)
    x_min = min(path.bbox()[0] for path in source_contours())
    left_bearing = 35
    advance = round((132.40 - x_min) * scale + 70)
    pen = T2CharStringPen(advance, None)

    def point(value: complex) -> tuple[float, float]:
        return (round(left_bearing + (value.real - x_min) * scale, 3),
                round((39.42 - value.imag) * scale, 3))

    for contour in source_contours():
        pen.moveTo(point(contour[0].start))
        for segment in contour:
            if isinstance(segment, Line):
                pen.lineTo(point(segment.end))
            elif isinstance(segment, CubicBezier):
                pen.curveTo(point(segment.control1), point(segment.control2),
                            point(segment.end))
            elif isinstance(segment, QuadraticBezier):
                raise ValueError("Unexpected quadratic SVG segment")
            else:
                raise ValueError(f"Unexpected SVG segment: {type(segment)}")
        pen.closePath()

    glyph_order = font.getGlyphOrder() + ["v.claw"]
    cff = font["CFF "].cff
    charstrings = cff.topDictIndex[0].CharStrings
    charstrings.charStrings["v.claw"] = len(charstrings.charStringsIndex)
    charstrings.charStringsIndex.append(pen.getCharString(
        private=cff.topDictIndex[0].Private, globalSubrs=cff.GlobalSubrs))
    cff.topDictIndex[0].charset.append("v.claw")
    font.setGlyphOrder(glyph_order)
    font["maxp"].numGlyphs = len(glyph_order)
    font["hmtx"]["v.claw"] = (advance, left_bearing)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[0xE000] = "v.claw"

    addOpenTypeFeaturesFromString(font, """
        languagesystem DFLT dflt;
        languagesystem latn dflt;
        feature ss01 { sub l_v by v.claw; sub u_v by v.claw; } ss01;
        feature calt {
            sub l_w l_v' by v.claw;
            sub u_w l_v' by v.claw;
            sub u_w u_v' by v.claw;
        } calt;
    """)
    for name in font["name"].names:
        if name.nameID == 5:
            value = name.toUnicode()
            if VERSION_NOTE not in value:
                name.string = f"{value}; {VERSION_NOTE}".encode(name.getEncoding())

    font["head"].modified = round((datetime(2026, 9, 29, tzinfo=timezone.utc)
                                    - datetime(1904, 1, 1, tzinfo=timezone.utc)).total_seconds())

    font.save(font_path)
    font.flavor = "woff2"
    font.save(font_path.with_suffix(".woff2"))
    print(f"Added v.claw: advance={advance}, side bearings=35/35, scale={scale:.4f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("font", nargs="?", type=Path, default=FONT)
    build(parser.parse_args().font)
