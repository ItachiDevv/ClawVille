"""Render text in Clawville Display with the full embossed brand layering.

Usage: python render-embossed-text.py "Your Text" out.png [font_size]
Layers (bottom to top): chocolate offset shadow -> gradient gold face ->
darker inner rim hugging the edge -> soft top-edge highlight.
Output is a transparent PNG sized to fit.
"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "ClawvilleDisplay.otf")

TOP = (255, 228, 110)      # face gradient top
MID = (248, 208, 56)       # Logo Yellow
BOT = (238, 192, 48)       # deep gold bottom
RIM = (216, 158, 34)       # inner rim
HIL = (255, 246, 200)      # top highlight
SHA = (95, 50, 16)         # chocolate shadow
SHA2 = (60, 30, 8)         # deep shadow


def render(text, size=160):
    font = ImageFont.truetype(FONT, size)
    pad = size
    dummy = Image.new("L", (10, 10))
    d = ImageDraw.Draw(dummy)
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
    W, H = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
    mask_im = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask_im)
    d.text((pad - x0, pad - y0), text, font=font, fill=255)
    mask = np.asarray(mask_im) > 96

    k = max(3, int(size * 0.026) | 1)
    eroded = np.asarray(mask_im.filter(ImageFilter.MinFilter(k))) > 96
    rim = mask & ~eroded

    hshift = max(2, int(size * 0.06))
    shifted = np.zeros_like(eroded)
    shifted[hshift:, :] = eroded[:-hshift, :]
    highlight = eroded & ~shifted

    out = np.zeros((H, W, 4), dtype=np.uint8)

    def paint(m, color):
        out[m] = (*color, 255)

    # shadow layers (hard offset like the logo)
    dx, dy = int(size * 0.045), int(size * 0.075)
    sh2 = np.zeros_like(mask)
    sh2[dy + 3:, dx + 2:] = mask[:-(dy + 3), :-(dx + 2)]
    paint(sh2, SHA2)
    sh = np.zeros_like(mask)
    sh[dy:, dx:] = mask[:-dy, :-dx]
    paint(sh & ~mask, SHA)

    # gradient face
    ys, xs = np.where(mask)
    if len(ys):
        ymin, ymax = ys.min(), ys.max()
        t = (ys - ymin) / max(1, ymax - ymin)
        cols = np.empty((len(ys), 3))
        for c in range(3):
            a, m, b = TOP[c], MID[c], BOT[c]
            cols[:, c] = np.where(t < 0.18, a + (m - a) * (t / 0.18),
                                  m + (b - m) * ((t - 0.18) / 0.82))
        out[ys, xs, :3] = cols.astype(np.uint8)
        out[ys, xs, 3] = 255

    # inner rim + highlight
    paint(rim, RIM)
    # highlight kept subtle: blend 45%
    hm = highlight & ~rim
    out[hm, :3] = (out[hm, :3].astype(int) * 0.55 + np.array(HIL) * 0.45).astype(np.uint8)

    img = Image.fromarray(out)
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


if __name__ == "__main__":
    text = sys.argv[1] if len(sys.argv) > 1 else "Clawville"
    dst = sys.argv[2] if len(sys.argv) > 2 else "embossed.png"
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 160
    render(text, size).save(dst)
    print("saved", dst)
