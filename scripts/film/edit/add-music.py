#!/usr/bin/env python3
"""Put the music lane into index.html.

  python add-music.py <song file in assets/music> <song second at video 0>

The lane sits under the voiceover: 0.32 while a voice line plays, 0.62 in the gaps,
0.85 on the two hits (dropA, launchHit) for 0.6 s, a 1.4 s fade at the end.
Voice windows come from the vo-* audio elements already in index.html.
"""
import json
import re
import sys
from pathlib import Path

here = Path(__file__).parent
song, media_start = sys.argv[1], float(sys.argv[2])
html = (here / "index.html").read_text(encoding="utf-8")
T = json.loads((here / "beats.json").read_text())
end = T["end"]

vo = []
for m in re.finditer(r'<audio id="vo-\d+"[^>]*>', html):
    tag = m.group(0)
    s = float(re.search(r'data-start="([^"]+)"', tag).group(1))
    d = float(re.search(r'data-duration="([^"]+)"', tag).group(1))
    vo.append((s, s + d))
vo.sort()

UNDER, GAP, HIT = 0.32, 0.62, 0.85
pts = [(0.0, 0.0), (0.25, GAP)]
for s, e in vo:
    pts += [(max(0.3, s - 0.25), GAP), (s, UNDER), (e, UNDER), (e + 0.3, GAP)]
for hit in (T["dropA"], T["launchHit"]):
    pts += [(hit - 0.05, HIT), (hit + 0.6, HIT)]
pts += [(end - 1.4, GAP), (end, 0.0)]
# keep the time order and drop points that go back in time (the last write wins at a time)
lane = {}
for t, v in sorted(pts):
    if 0 <= t <= end:
        lane[round(t, 3)] = v
points = [{"t": t, "v": v} for t, v in sorted(lane.items())]
auto = json.dumps({"version": 1, "lanes": [{"target": "volume", "points": points}]}, separators=(",", ":"))
tag = (f'<audio id="bgm" data-timeline-role="music" src="assets/music/{song}" data-start="0" '
       f'data-duration="{end:g}" data-media-start="{media_start:g}" data-track-index="10" '
       f"data-automation='{auto}'></audio>")
html = re.sub(r'\n\s*<audio id="bgm"[^\n]*', "", html)
html = html.replace("      <!-- VOICEOVER", "      " + tag + "\n\n      <!-- VOICEOVER", 1)
(here / "index.html").write_text(html, encoding="utf-8")
print(f"music lane: {song} from {media_start:g} s, {len(points)} points, voice windows {len(vo)}")
