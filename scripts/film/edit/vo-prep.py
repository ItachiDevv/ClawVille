#!/usr/bin/env python3
"""Trim, speed up and measure the raw TTS lines.

  python vo-prep.py <raw dir> <out dir> [tempo, default 1.12]

For every <raw dir>/*.wav: cut leading/trailing silence (-45 dB), apply atempo, a 10 ms
fade-in, 48 kHz stereo -> <out dir>/<same name>.wav. Then it writes <out dir>/durations.json:
  { "<id>": { "d": seconds, "gaps_end": [pause ends in seconds] } }
gaps_end are the starts of the phrases after each pause (silencedetect -38 dB, 0.12 s): use them
to land cards and cuts on spoken words (for example the 5 agent names, the 3 prize amounts).
The arena demo used tempo 1.12 with the "coral" voice (owner: "slightly faster pace").
"""
import json
import re
import subprocess
import sys
from pathlib import Path

raw, out = Path(sys.argv[1]), Path(sys.argv[2])
tempo = float(sys.argv[3]) if len(sys.argv) > 3 else 1.12
out.mkdir(parents=True, exist_ok=True)
AF = ("silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,"
      "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,"
      f"atempo={tempo},afade=t=in:d=0.01")
res = {}
for f in sorted(raw.glob("*.wav")):
    dst = out / f.name
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(f), "-af", AF,
                    "-ar", "48000", "-ac", "2", str(dst)], check=True)
    d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(dst)],
                             capture_output=True, text=True).stdout)
    s = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(dst), "-af", "silencedetect=noise=-38dB:d=0.12", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    res[f.stem] = {"d": round(d, 2), "gaps_end": [round(float(x), 2) for x in re.findall(r"silence_end: ([0-9.]+)", s)]}
    print(f.stem, res[f.stem])
(out / "durations.json").write_text(json.dumps(res, indent=1))
print("total", round(sum(v["d"] for v in res.values()), 2), "s")
