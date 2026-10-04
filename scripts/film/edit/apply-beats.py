#!/usr/bin/env python3
"""Copy beats.json into a Hyperframes composition (index.html in the current folder).

beats.json maps beat names to video seconds, plus "end". Every element that carries
data-beat="<name>" is retimed:

  <section>/<video>  data-start = T[name] (+ data-part i/n), data-duration = up to the next
                     section beat in time (or up to data-beat-end="<name>")
  <audio>            data-start = T[name] (+ part) + data-off; data-duration is kept

Beat names used only inside the GSAP script (sub-beats such as "dropA", "n1", "p1") need no
element. The script also writes beats.json into <script id="beats" type="application/json">
and the root data-duration, so the timeline reads the same numbers (T = JSON.parse(...)).

  python apply-beats.py            # from the composition folder

Worked example: brag-output-2026-09-30-arena/composition (docs/video-production.md).
"""
import json
import re
from pathlib import Path

here = Path.cwd()
T = json.loads((here / "beats.json").read_text())
html = (here / "index.html").read_text(encoding="utf-8")
if "end" not in T:
    raise SystemExit("beats.json needs an 'end' key")

TAG = r'<(?:section|audio|video)\b[^>]*\bdata-beat="([a-zA-Z0-9]+)"[^>]*>'
# the section beats = beats that a <section> or <video> starts on; their time order is the cut order
section_beats = {m.group(1) for m in re.finditer(r'<(?:section|video)\b[^>]*\bdata-beat="([a-zA-Z0-9]+)"', html)}
missing = sorted(b for b in section_beats if b not in T)
if missing:
    raise SystemExit(f"beats.json has no time for: {', '.join(missing)}")
ORDER = sorted(section_beats, key=lambda b: T[b]) + ["end"]
for a, b in zip(ORDER, ORDER[1:]):
    if not T[a] < T[b]:
        raise SystemExit(f"beats out of order: {a}={T[a]} >= {b}={T[b]}")


def fmt(x):
    return f"{round(x, 3):g}"


def retime(m):
    tag, beat = m.group(0), m.group(1)
    if beat not in T:
        raise SystemExit(f"beats.json has no time for: {beat}")
    endb = re.search(r'data-beat-end="([a-zA-Z0-9]+)"', tag)
    if endb:
        stop = T[endb.group(1)]
    else:
        later = [T[b] for b in ORDER if T[b] > T[beat]]
        stop = min(later) if later else T["end"]
    start, span = T[beat], stop - T[beat]
    part = re.search(r'data-part="(\d+)/(\d+)"', tag)
    if part:
        i, n = int(part.group(1)), int(part.group(2))
        span /= n
        start += i * span
    if tag.startswith("<audio"):
        off = re.search(r'data-off="(-?[\d.]+)"', tag)
        start += float(off.group(1)) if off else 0.0
        return re.sub(r'data-start="[^"]*"', f'data-start="{fmt(start)}"', tag)
    tag = re.sub(r'data-start="[^"]*"', f'data-start="{fmt(start)}"', tag)
    return re.sub(r'data-duration="[^"]*"', f'data-duration="{fmt(span)}"', tag)


html, n = re.subn(TAG, retime, html)
html = re.sub(r'(<div id="root"[^>]*data-duration=")[^"]*(")', lambda m: m.group(1) + fmt(T["end"]) + m.group(2), html)
html = re.sub(r'(<script id="beats" type="application/json">).*?(</script>)',
              lambda m: m.group(1) + json.dumps(T) + m.group(2), html, flags=re.S)
(here / "index.html").write_text(html, encoding="utf-8")
print(f"retimed {n} elements; {len(ORDER) - 1} section beats; end {T['end']} s")
