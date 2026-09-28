"""Build the ClawVille icon and social asset set from the approved raster art.

Run from any directory: python branding/scripts/build_icons.py [-o report.md]
Requires Pillow and NumPy. No source asset is modified.
"""

from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
BRANDING = ROOT / "branding"
ICONS = BRANDING / "assets" / "icons"
ALT = ICONS / "alt"
SOCIAL = BRANDING / "assets" / "social"
WEB_PUBLIC = ROOT / "apps" / "web" / "public"
WEB_APP = ROOT / "apps" / "web" / "src" / "app"
LOGO_WORK = BRANDING / "logo-work"
SOURCE = BRANDING / "assets" / "logos" / "clawville-logo-official.png"
STICKER = BRANDING / "assets" / "stickers" / "claw-yellow.png"
SIGN = BRANDING / "assets" / "logos" / "clawville-logo-wood-large-transparent.png"
BEACH = BRANDING / "assets" / "world" / "beach-banner-wide.jpg"
NAVY = (0, 24, 88)
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


def publish_web_assets() -> list[Path]:
    """Publish versioned web assets from the approved sign and icon set."""
    brand_dir = WEB_PUBLIC / "brand"
    icon_dir = WEB_PUBLIC / "icons"
    brand_dir.mkdir(parents=True, exist_ok=True)
    icon_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []

    with Image.open(SIGN) as source:
        if source.size != (1792, 576) or source.mode != "RGBA":
            raise ValueError("Keyed sign must be 1792x576 RGBA")
        for width, height, quality in ((480, 154, 68), (960, 309, 68)):
            # Premultiplied resize keeps transparent edge pixels free of dark halos.
            sign = source.convert("RGBa").resize((width, height), Image.Resampling.LANCZOS).convert("RGBA")
            path = brand_dir / f"clawville-sign-v1-{width}.webp"
            data = BytesIO()
            sign.save(data, format="WEBP", quality=quality, method=6)
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


def make_alt(sticker: Image.Image, size: int) -> Image.Image:
    scale = 4
    large = size * scale
    alpha = sticker.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("Sticker has no visible pixels")
    visible = sticker.crop(bbox)
    target_height = round(large * 0.78)
    target_width = round(visible.width * target_height / visible.height)
    visible = visible.resize((target_width, target_height), Image.Resampling.LANCZOS)
    tile = Image.new("RGBA", (large, large), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    draw.rounded_rectangle((0, 0, large - 1, large - 1), radius=round(large * 0.2), fill=(*NAVY, 255))
    tile.alpha_composite(visible, ((large - target_width) // 2, (large - target_height) // 2))
    tile = tile.resize((size, size), Image.Resampling.LANCZOS)
    return tile.filter(ImageFilter.UnsharpMask(radius=0.6, percent=80, threshold=2))


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


COMPARE_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClawVille icon comparison</title><style>
:root{font-family:Arial,sans-serif;color:#eaf3ff;background:#061520}*{box-sizing:border-box}
body{margin:0;padding:28px;max-width:1380px}h1,h2{margin:0 0 16px}section{margin:30px 0}
.row{display:flex;flex-wrap:wrap;gap:18px;align-items:start}.card{padding:18px;border:1px solid #365171;border-radius:14px;background:#102337}
.tabbar{display:flex;gap:5px;align-items:end;padding:8px 10px 0;border-radius:11px 11px 0 0;min-width:520px}
.tabbar.dark{background:#202124}.tabbar.light{background:#dce0e5;color:#202124}
.tab{display:flex;gap:8px;align-items:center;width:230px;padding:10px 12px;border-radius:9px 9px 0 0;background:#30343b;font-size:13px}
.light .tab{background:#fafafa}.tab img{width:16px;height:16px}.tab.big img{width:32px;height:32px}
.phone{width:320px;padding:24px;border:8px solid #293444;border-radius:38px;background:linear-gradient(#378baf,#70bfbb 55%,#e3cf9c);color:white}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;text-align:center;font-size:12px}
.grid img{width:68px;height:68px;object-fit:cover;border-radius:15px;box-shadow:0 3px 8px #0008}.grid label{display:block;margin-top:6px}
.mask img{width:160px;height:160px;object-fit:cover}.circle img{clip-path:circle(50%)}.squircle img{border-radius:36%}.rounded img{border-radius:20%}
.og img{display:block;max-width:100%;height:auto}.og.small img{width:600px}
p{line-height:1.4;color:#c9d5e0}small{color:#b7c8d6}
</style></head><body>
<h1>ClawVille icon comparison</h1><p>Set 1 uses the full official logo. Set 2 uses the yellow claw sticker.</p>
<section><h2>Browser tabs</h2><div class="row">
<div class="card"><small>Dark · 16 px</small><div class="tabbar dark"><div class="tab"><img src="../assets/icons/icon-clawgirl-16.png">ClawVille · Set 1</div><div class="tab"><img src="../assets/icons/alt/icon-claw-16.png">ClawVille · Set 2</div></div></div>
<div class="card"><small>Light · 16 px</small><div class="tabbar light"><div class="tab"><img src="../assets/icons/icon-clawgirl-16.png">ClawVille · Set 1</div><div class="tab"><img src="../assets/icons/alt/icon-claw-16.png">ClawVille · Set 2</div></div></div>
<div class="card"><small>Dark · 32 px at 2×</small><div class="tabbar dark"><div class="tab big"><img src="../assets/icons/icon-clawgirl-32.png">ClawVille · Set 1</div><div class="tab big"><img src="../assets/icons/alt/icon-claw-32.png">ClawVille · Set 2</div></div></div>
<div class="card"><small>Light · 32 px at 2×</small><div class="tabbar light"><div class="tab big"><img src="../assets/icons/icon-clawgirl-32.png">ClawVille · Set 1</div><div class="tab big"><img src="../assets/icons/alt/icon-claw-32.png">ClawVille · Set 2</div></div></div>
</div></section>
<section><h2>Phone home screen</h2><div class="phone"><div class="grid">
<div><img src="../assets/icons/apple-touch-icon-180.png"><label>Apple touch</label></div>
<div><img src="../assets/icons/pwa-192.png"><label>PWA 192</label></div>
<div><img src="../assets/icons/pwa-512.png"><label>PWA 512</label></div>
</div></div></section>
<section><h2>Maskable icon</h2><div class="row">
<div class="card mask circle"><img src="../assets/icons/pwa-maskable-512.png"><p>Circle</p></div>
<div class="card mask squircle"><img src="../assets/icons/pwa-maskable-512.png"><p>Squircle</p></div>
<div class="card mask rounded"><img src="../assets/icons/pwa-maskable-512.png"><p>Rounded square</p></div>
</div></section>
<section><h2>OG card · 1200 × 630</h2><div class="og"><img src="../assets/social/og-1200x630.png"></div></section>
<section><h2>OG card · 600 × 315 display</h2><div class="og small"><img src="../assets/social/og-1200x630.png"></div></section>
</body></html>
"""


def build(report_path: Path) -> None:
    for directory in (ICONS, ALT, SOCIAL, LOGO_WORK, report_path.parent):
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

    sticker = Image.open(STICKER).convert("RGBA")
    alternate = {size: make_alt(sticker, size) for size in (16, 32, 48)}
    for size, image in alternate.items():
        path = ALT / f"icon-claw-{size}.png"
        save_png(image, path)
        outputs.append(path)
    path = ALT / "favicon-claw.ico"
    write_ico([alternate[n] for n in (16, 32, 48)], path)
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

    path = LOGO_WORK / "icons-compare.html"
    path.write_text(COMPARE_HTML, encoding="utf-8", newline="\n")
    outputs.append(path)

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
    parser.add_argument("-o", "--output", type=Path, default=LOGO_WORK / "icons-report.md",
                        help="Path for the generated asset report")
    args = parser.parse_args()
    build(args.output.resolve())
