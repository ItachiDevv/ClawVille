"""Build the seal and banner atlas with real Barlow glyphs at asset-build time."""
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

# Banner plate occupies the right 256 x 768 part of the atlas.
d.rectangle((772, 5, 1019, 763), fill=gold)
d.rectangle((781, 14, 1010, 741), fill=navy)
d.rectangle((793, 28, 998, 725), outline=gold, width=8)
claw = Image.open(root / 'apps/web/public/assets/slot-symbols/claw.png').convert('RGBA')
claw.thumbnail((222, 300), Image.Resampling.LANCZOS)
mask = claw.getchannel('A')
silhouette = Image.new('RGBA', claw.size, gold)
im.paste(silhouette, (896 - claw.width // 2, 120), mask)
d.text((896, 540), 'CLAWVILLE', font=ImageFont.truetype(str(ttf_path), 31), fill=gold, anchor='mm')
d.text((896, 585), 'EXCHANGE', font=ImageFont.truetype(str(ttf_path), 29), fill=gold, anchor='mm')
for x in range(779, 1016, 20):
    d.polygon(((x, 743), (x + 10, 766), (x + 20, 743)), fill=gold)
im.save(out)
