"""Build the ClawVille icon and social asset set from the approved raster art.

Run from any directory: python branding/scripts/build_icons.py [-o report.md]
Requires Pillow and NumPy. Banner rendering needs headless Chrome at the Windows path below.
Versioned public files (apps/web/public/brand, apps/web/public/icons) are never overwritten;
the Next.js metadata files in apps/web/src/app are refreshed.
"""

from __future__ import annotations

import argparse
import tempfile
from io import BytesIO
from pathlib import Path
import struct
import subprocess
from tempfile import TemporaryDirectory
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
BRANDING = ROOT / "branding"
ICONS = BRANDING / "assets" / "icons"
SOCIAL = BRANDING / "assets" / "social"
WEB_PUBLIC = ROOT / "apps" / "web" / "public"
WEB_APP = ROOT / "apps" / "web" / "src" / "app"
SOURCE = BRANDING / "assets" / "logos" / "clawville-logo-official.png"
SIGN = BRANDING / "assets" / "logos" / "clawville-logo-wood-large-transparent.png"
VECTOR_SIGN = BRANDING / "assets" / "logos" / "clawville-sign-font.svg"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
CHROME_PROFILE = Path.home() / ".cold-load-probe-profiles" / "clawville-banner-v2"
BEACH = BRANDING / "assets" / "world" / "beach-banner-wide.jpg"
SAFE_RADIUS = 204.8


def save_png(image: Image.Image, path: Path) -> None:
    image.save(path, format="PNG", optimize=True)


def write_hosted_asset(path: Path, payload: bytes) -> None:
    """Keep existing public URLs bound to their original bytes."""
    if path.exists():
        if path.read_bytes() != payload:
            raise ValueError(
                f"{path} already exists with different bytes; hosted paths are immutable, "
                "bump the version suffix (for example -v2)"
            )
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def copy_app_assets() -> list[Path]:
    """Copy generated assets to Next.js metadata file paths."""
    copies = (
        (ICONS / "favicon-clawgirl.ico", WEB_APP / "favicon.ico"),
        (ICONS / "icon-clawgirl-96.png", WEB_APP / "icon.png"),
        (ICONS / "apple-touch-icon-180.png", WEB_APP / "apple-icon.png"),
        (SOCIAL / "og-1200x630.jpg", WEB_APP / "opengraph-image.jpg"),
        (SOCIAL / "og-1200x630.jpg", WEB_APP / "twitter-image.jpg"),
    )
    for source, target in copies:
        payload = source.read_bytes()
        if not target.exists() or target.read_bytes() != payload:
            target.write_bytes(payload)
    return [target for _, target in copies]


def render_sign_svg(width: int, height: int) -> Image.Image:
    """Rasterize the vector sign at the exact output dimensions with Chrome."""
    with TemporaryDirectory(prefix=".sign-render-", dir=BRANDING) as work_dir:
        work = Path(work_dir)
        CHROME_PROFILE.parent.mkdir(parents=True, exist_ok=True)
        html = work / ".render-sign.html"
        shot = work / f".render-sign-{width}.png"
        html.write_text(
            '<!doctype html><style>html,body{margin:0;background:transparent}'
            f'img{{display:block;width:{width}px;height:{height}px}}</style>'
            f'<img src="{VECTOR_SIGN.resolve().as_uri()}">', encoding="utf-8"
        )
        command = [str(CHROME), "--headless=new", "--disable-gpu", "--no-first-run",
                   "--no-default-browser-check", "--disable-extensions",
                   "--disable-background-mode", "--force-device-scale-factor=1",
                   f"--user-data-dir={CHROME_PROFILE}",
                   "--default-background-color=00000000",
                   f"--screenshot={shot}",
                   f"--window-size={max(width, 800)},{max(height + 120, 600)}",
                   html.as_uri()]
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
        if result.returncode or not shot.exists():
            raise RuntimeError(f"Chrome SVG render failed: {result.stderr[-1000:]}")
        with Image.open(shot) as captured:
            return captured.convert("RGBA").crop((0, 0, width, height))


def publish_web_assets() -> list[Path]:
    """Publish versioned web assets from the approved sign and icon set."""
    brand_dir = WEB_PUBLIC / "brand"
    icon_dir = WEB_PUBLIC / "icons"
    brand_dir.mkdir(parents=True, exist_ok=True)
    icon_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []

    svg_size = ET.parse(VECTOR_SIGN).getroot().attrib
    aspect = int(svg_size["width"]) / int(svg_size["height"])
    w1 = round(aspect * 88)
    for label, width, height in (("1x", w1, 88), ("2x", 2 * w1, 176)):
        path = brand_dir / f"clawville-banner-v2-{label}.webp"
        if path.exists():
            print(f"kept existing {path}")
            outputs.append(path)
            continue
        sign = render_sign_svg(width, height)
        data = BytesIO()
        sign.save(data, format="WEBP", quality=72, method=6, exact=True)
        write_hosted_asset(path, data.getvalue())
        outputs.append(path)

    for source_name, target_name in (("pwa-192.png", "pwa-192-v1.png"),
                                     ("pwa-512.png", "pwa-512-v1.png"),
                                     ("pwa-maskable-512.png", "pwa-maskable-512-v1.png")):
        with Image.open(ICONS / source_name) as icon:
            path = icon_dir / target_name
            data = BytesIO()
            icon.save(data, format="PNG", optimize=True)
            write_hosted_asset(path, data.getvalue())
            outputs.append(path)

    return outputs


def resize_logo(source: Image.Image, size: int) -> Image.Image:
    result = source.resize((size, size), Image.Resampling.LANCZOS)
    if size <= 64:
        result = result.filter(ImageFilter.UnsharpMask(radius=0.6, percent=80, threshold=2))
    return result


def write_ico(images: list[Image.Image], path: Path) -> None:
    """Embed our exact Lanczos PNGs instead of asking Pillow to resample again."""
    payloads: list[bytes] = []
    for image in images:
        data = BytesIO()
        image.convert("RGBA").save(data, format="PNG", optimize=True)
        payloads.append(data.getvalue())
    offset = 6 + 16 * len(images)
    with path.open("wb") as output:
        output.write(struct.pack("<HHH", 0, 1, len(images)))
        for image, payload in zip(images, payloads):
            width, height = image.size
            output.write(struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(payload), offset))
            offset += len(payload)
        for payload in payloads:
            output.write(payload)


def feature_measurement(source: Image.Image) -> tuple[float, str]:
    """Measure pink bow and red claw pixels in fixed source regions.

    The region gates exclude pink ear pads, antennae, red shirt art, and surf.
    The color gates include the antialiased outer feature pixels with visible color.
    """
    a = np.asarray(source, dtype=np.int16)
    y, x = np.indices(a.shape[:2])
    red, green, blue = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    bow = (
        (y < 175) & (x > 350) & (x < 700)
        & (red > 170) & (red > green * 1.08) & (blue > green * 0.95)
    )
    claws = (
        (y > 530) & (y < 930) & ((x < 400) | (x > 630))
        & (red > 75) & (red > green * 1.12) & (red > blue * 1.13)
    )
    if not bow.any() or not claws.any():
        raise ValueError("The source bow or claws no longer match the measurement gates")
    center = (source.width - 1) / 2
    radius = float(np.hypot(x[bow | claws] - center, y[bow | claws] - center).max())

    def bounds(mask: np.ndarray) -> str:
        return f"x={x[mask].min()}..{x[mask].max()}, y={y[mask].min()}..{y[mask].max()}"

    return radius, f"Bow: {bounds(bow)}. Claws: {bounds(claws)}. Farthest feature pixel: {radius:.3f} source px."


def make_maskable(source: Image.Image) -> tuple[Image.Image, int, float, str]:
    farthest, measurement = feature_measurement(source)
    # Pixel-center geometry gives the largest integer side that stays in the safe circle.
    side = min(512, int((2 * SAFE_RADIUS * source.width / (2 * farthest)) // 1))
    while side < 512 and farthest * (side + 1) / source.width <= SAFE_RADIUS:
        side += 1
    while farthest * side / source.width > SAFE_RADIUS:
        side -= 1
    # Even sides have an exact integer offset on an even 512 px canvas.
    # An odd side shifts its feature center by half a pixel.
    side -= side % 2
    inset = resize_logo(source, side)
    offset = (512 - side) // 2

    # Extend each edge pixel into the padding. Its row colors retain the source's
    # sky-to-ocean transition; blur the extension to avoid a hard square seam.
    # Only the inset boundary blends. The bow and claws remain on opaque pixels.
    edge = np.asarray(inset)
    remainder = 512 - side - offset
    extension = np.pad(edge, ((offset, remainder), (offset, remainder), (0, 0)), mode="edge").astype(np.float32)
    # The top and bottom rows fade to their own mean edge color. This removes
    # repeated color streaks in the padded sky and ocean.
    for row in range(offset):
        fade = (offset - row) / offset
        extension[row] = extension[row] * (1 - fade) + edge[0].mean(axis=0) * fade
    for row in range(offset + side, 512):
        fade = (row - (offset + side - 1)) / remainder
        extension[row] = extension[row] * (1 - fade) + edge[-1].mean(axis=0) * fade
    background = Image.fromarray(np.uint8(np.clip(extension, 0, 255)), "RGB")
    background = background.filter(ImageFilter.GaussianBlur(radius=12))
    # The blend stays in the outer sky/ocean band, away from the feature pixels.
    blend = np.minimum.reduce(np.broadcast_arrays(
        np.arange(side)[:, None], np.arange(side)[::-1, None],
        np.arange(side)[None, :], np.arange(side)[None, ::-1]
    ))
    mask = Image.fromarray(np.uint8(np.clip(blend / 22, 0, 1) * 255), "L")
    background.paste(inset, (offset, offset), mask)
    return background, side, farthest * side / source.width, measurement


def make_og(beach: Image.Image, sign: Image.Image) -> Image.Image:
    width = round(beach.width * 630 / beach.height)
    background = beach.resize((width, 630), Image.Resampling.LANCZOS)
    left = (width - 1200) // 2
    background = background.crop((left, 0, left + 1200, 630)).convert("RGBA")
    sign_width = 540
    sign_height = round(sign.height * sign_width / sign.width)
    sign = sign.resize((sign_width, sign_height), Image.Resampling.LANCZOS)
    # Left edge starts beyond the lobster's right claw in the center crop.
    background.alpha_composite(sign, (620, 45))
    return background.convert("RGB")


def build(report_path: Path) -> None:
    for directory in (ICONS, SOCIAL, report_path.parent):
        directory.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []
    source = Image.open(SOURCE).convert("RGB")
    if source.size != (1024, 1024):
        raise ValueError(f"Official logo must be 1024 square: {source.size}")
    main: dict[int, Image.Image] = {}
    for size in (16, 32, 48, 96, 180, 192, 400, 512):
        main[size] = resize_logo(source, size)
    for size in (16, 32, 48, 96):
        path = ICONS / f"icon-clawgirl-{size}.png"
        save_png(main[size], path)
        outputs.append(path)
    for size, name in ((180, "apple-touch-icon-180.png"), (192, "pwa-192.png"),
                       (400, "social-avatar-400.png"), (512, "pwa-512.png")):
        path = ICONS / name
        save_png(main[size], path)
        outputs.append(path)
    path = ICONS / "favicon-clawgirl.ico"
    write_ico([main[n] for n in (16, 32, 48)], path)
    outputs.append(path)

    maskable, side, used_radius, measurement = make_maskable(source)
    path = ICONS / "pwa-maskable-512.png"
    save_png(maskable, path)
    outputs.append(path)

    og = make_og(Image.open(BEACH).convert("RGB"), Image.open(SIGN).convert("RGBA"))
    path = SOCIAL / "og-1200x630.png"
    save_png(og, path)
    outputs.append(path)
    path = SOCIAL / "og-1200x630.jpg"
    og.save(path, format="JPEG", quality=88, subsampling=0, optimize=True)
    outputs.append(path)
    outputs.extend(publish_web_assets())
    outputs.extend(copy_app_assets())

    lines = ["# ClawVille icon set", "", "Rebuild: `python branding/scripts/build_icons.py`", "",
             "## Maskable measurement", "", measurement,
             f"Centered full-square side: {side}/512 px ({side / 512:.4%} of canvas).",
             f"Farthest feature after scaling: {used_radius:.3f} px; safe radius: {SAFE_RADIUS:.1f} px.",
             "", "## Files", "", "| File | Pixels / frames | Bytes |", "|---|---:|---:|"]
    for path in outputs:
        if path.suffix == ".ico":
            dimensions = "16, 32, 48"
        elif path.suffix == ".html":
            dimensions = "n/a"
        else:
            with Image.open(path) as image:
                dimensions = f"{image.width} × {image.height}"
        lines.append(f"| `{path.relative_to(ROOT).as_posix()}` | {dimensions} | {path.stat().st_size} |")
    lines += ["", "Unable to do: none.", ""]
    report_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"Built {len(outputs)} assets; report: {report_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", type=Path, default=Path(tempfile.gettempdir()) / "clawville-icons-report.md",
                        help="Path for the generated asset report")
    args = parser.parse_args()
    build(args.output.resolve())
