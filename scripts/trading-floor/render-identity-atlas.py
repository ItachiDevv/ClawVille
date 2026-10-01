"""Build the seal and banner atlas with real Barlow glyphs at asset-build time."""
import json
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1])
out.parent.mkdir(parents=True, exist_ok=True)
font_path = root / 'branding/assets/fonts/barlow-600.woff2'
ttf_path = out.with_suffix('.ttf')
font = TTFont(font_path)
font.flavor = None
font.save(ttf_path)

im = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
gold = (224, 192, 112, 255)
navy = (2, 17, 50, 255)
cx = cy = 384
d.ellipse((0, 0, 768, 768), fill=gold)
d.ellipse((10, 10, 758, 758), fill=navy)
d.ellipse((22, 22, 746, 746), outline=gold, width=6)
d.ellipse((120, 120, 648, 648), outline=(140, 110, 57, 255), width=5)
d.ellipse((141, 141, 627, 627), fill=(0, 0, 0, 0))
label_font = ImageFont.truetype(str(ttf_path), 38)
small_font = ImageFont.truetype(str(ttf_path), 28)
d.text((cx, 665), 'CLAWVILLE EXCHANGE', font=label_font, fill=gold, anchor='mm', stroke_width=1)
d.text((cx, 91), 'THE GOLDEN CLAW', font=small_font, fill=gold, anchor='mm')
for x in (104, 664):
    d.regular_polygon((x, 384, 18), 5, rotation=-90, fill=gold)

# The 250 x 500 banner matches its 210 x 420 wu quad without stretching.
bx, by, bw, bh = 772, 5, 250, 500
d.rectangle((bx, by, bx + bw - 1, by + bh - 23), fill=gold)
d.rectangle((bx + 9, by + 9, bx + bw - 10, by + bh - 36), fill=navy)
d.rectangle((bx + 21, by + 23, bx + bw - 22, by + bh - 49), outline=gold, width=8)
claw = Image.open(root / 'apps/web/public/assets/slot-symbols/claw.png').convert('RGBA')
claw.thumbnail((210, 210), Image.Resampling.LANCZOS)
mask = claw.getchannel('A')
silhouette = Image.new('RGBA', claw.size, gold)
im.paste(silhouette, (bx + bw // 2 - claw.width // 2, by + 83), mask)
d.text((bx + bw // 2, by + 373), 'CLAWVILLE', font=ImageFont.truetype(str(ttf_path), 31), fill=gold, anchor='mm')
d.text((bx + bw // 2, by + 419), 'EXCHANGE', font=ImageFont.truetype(str(ttf_path), 29), fill=gold, anchor='mm')
for x in range(bx + 7, bx + bw - 20, 20):
    d.polygon(((x, by + bh - 27), (x + 10, by + bh - 1), (x + 20, by + bh - 27)), fill=gold)
# The lintel lies below the seal and clear of the banner column.
lintel = {'x': 8, 'y': 840, 'w': 600, 'h': 64}
for rect, text, size in ((lintel, 'TO CLAWVILLE', 46),):
    x, y, w, h = (rect[key] for key in ('x', 'y', 'w', 'h'))
    d.rectangle((x, y, x + w - 1, y + h - 1), fill=navy)
    d.text((x + w / 2, y + h / 2), text,
           font=ImageFont.truetype(str(ttf_path), size), fill=gold, anchor='mm')
im.save(out)
print(json.dumps({'x': bx, 'y': by, 'w': bw, 'h': bh,
                  'lintel': lintel}))
