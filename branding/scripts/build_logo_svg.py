"""Combine the A sign geometry with procedural vector wood.

Run: python -B branding/scripts/build_logo_svg.py
Use -o to select another SVG output path.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory
import xml.etree.ElementTree as ET
from pathlib import Path
from wood import wood_plank

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
LOGOS = ROOT / "assets/logos"
SOURCE = LOGOS / "src"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
PROFILE = Path.home() / ".cold-load-probe-profiles" / "clawville-logo-vector"
DEFAULT_OUTPUT = LOGOS / "clawville-logo-color.svg"
NS = "{http://www.w3.org/2000/svg}"


def build(output: Path) -> tuple[int, str]:
    template = (SOURCE / "candidate-a-constructed.svg").read_text(encoding="utf-8")
    if template.count('clip-path="url(#plankClip)"') != 1:
        raise ValueError("Unexpected A template structure")
    root = ET.fromstring(template)
    outline = root.find(f".//{NS}clipPath[@id='plankClip']/{NS}path")
    if outline is None or not outline.get("d"):
        raise ValueError("Could not find A plank outline")
    defs, plank = wood_plank(outline.get("d", ""), (29, 34, 972, 318), "logo")
    result = template.replace("</defs>", defs + "</defs>", 1)
    result, base_count = re.subn(r'<path d="[^"]+" fill="url\(#wood\)" stroke="[^"]+" stroke-width="[^"]+"/>', lambda _: plank, result, count=1)
    result, grain_count = re.subn(r'<g clip-path="url\(#plankClip\)" fill="none" stroke-linecap="round">.*?</g>', "", result, count=1, flags=re.DOTALL)
    if base_count != 1 or grain_count != 1:
        raise ValueError("Could not replace A wood fill and grain")
    result, wood_count = re.subn(r'  <linearGradient id="wood".*?</linearGradient>\n', "", result, count=1)
    result, clip_count = re.subn(r'  <clipPath id="plankClip".*?</clipPath>\n', "", result, count=1)
    if wood_count != 1 or clip_count != 1:
        raise ValueError("Could not remove unused A wood definitions")
    data = result.encode("utf-8")
    ET.fromstring(data)
    if len(data) > 200_000 or b"<text" in data or b"<image" in data:
        raise ValueError(f"Output violates SVG budget or vector rule: {len(data)} bytes")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    return len(data), hashlib.sha256(data).hexdigest()


def render(svg: Path, width: int, output: Path) -> None:
    height = round(width * 334 / 1000)
    output.parent.mkdir(parents=True, exist_ok=True)
    PROFILE.parent.mkdir(parents=True, exist_ok=True)
    shot = output.parent / f".shot-{width}.png"
    html = output.parent / ".render.html"
    html.write_text(
        '<!doctype html><style>html,body{margin:0;background:transparent}'
        f'img{{display:block;width:{width}px;height:{height}px}}</style>'
        f'<img src="{svg.resolve().as_uri()}">', encoding="utf-8")
    cmd = [str(CHROME), "--headless=new", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", "--disable-extensions",
           f"--user-data-dir={PROFILE}", "--default-background-color=00000000",
           f"--screenshot={shot}",
           f"--window-size={max(width, 1000)},{max(height + 120, 600)}",
           html.as_uri()]
    try:
        process = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        if process.returncode or not shot.exists():
            raise RuntimeError(process.stderr[-1200:])
        Image.open(shot).convert("RGBA").crop((0, 0, width, height)).save(output)
    finally:
        shot.unlink(missing_ok=True)
        html.unlink(missing_ok=True)


def masks(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    hsv = cv2.cvtColor(image[:, :, :3], cv2.COLOR_RGB2HSV)
    letter = ((hsv[:, :, 0] >= 16) & (hsv[:, :, 0] <= 37) &
              (hsv[:, :, 1] > 135) & (hsv[:, :, 2] > 175) &
              (image[:, :, 3] >= 128))
    return letter, image[:, :, 3] >= 128


def measure(work: Path) -> dict[str, float]:
    reference = np.asarray(Image.open(work / "reference-1000.png").convert("RGBA"))
    final = np.asarray(Image.open(work / "final-1000.png").convert("RGBA"))
    ref_letter, ref_silhouette = masks(reference)
    final_letter, final_silhouette = masks(final)

    def iou(a: np.ndarray, b: np.ndarray) -> float:
        return round(float(np.count_nonzero(a & b) / np.count_nonzero(a | b)), 4)

    error = np.abs(final[:, :, :3].astype(np.int16) - reference[:, :, :3].astype(np.int16))
    return {"letter_mask_iou": iou(ref_letter, final_letter),
            "silhouette_iou": iou(ref_silhouette, final_silhouette),
            "mean_abs_rgb_error": round(float(error[ref_silhouette].mean()), 2)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--render", action="store_true")
    args = parser.parse_args()
    size, digest = build(args.output)
    print(f"SVG: {args.output} | {size} bytes | sha256 {digest}")
    if args.render:
        with TemporaryDirectory(prefix=".logo-render-", dir=ROOT) as work_dir:
            work = Path(work_dir)
            shutil.copyfile(LOGOS / "clawville-logo-transparent.png", work / "reference-1000.png")
            render(SOURCE / "candidate-a-constructed.svg", 1000, work / "a-1000.png")
            for width in (1000, 120, 200):
                render(args.output, width, work / f"final-{width}.png")
            print(measure(work))


if __name__ == "__main__":
    main()
