#!/usr/bin/env bash
# Fast music pass on a finished master (no re-render): the track ducks under the voice
# (sidechain from the master's own audio), fades in and out, then the mix is normalised.
#   bash mix-music.sh <master.mp4> <music file> <out.mp4> [music start s, default 0] [music gain, default 0.3]
# The video stream is copied. Arena demo v5 (2026-10-02): gain 0.3, start 0, result -13.8 LUFS / -1.5 dBTP.
set -euo pipefail
M="$1"; MUS="$2"; OUT="$3"; START="${4:-0}"; GAIN="${5:-0.3}"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$M")
FADE=$(python -c "print(round($DUR - 1.7, 2))")
ffmpeg -hide_banner -loglevel error -y -i "$M" -i "$MUS" -filter_complex \
  "[1:a]atrim=$START:$(python -c "print($START + $DUR)"),asetpts=PTS-STARTPTS,aresample=48000,volume=$GAIN,afade=t=in:st=0:d=0.4,afade=t=out:st=$FADE:d=1.7[m];[0:a]aresample=48000,asplit=2[vo][sc];[m][sc]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350[md];[vo][md]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 256k "$OUT"
ffmpeg -hide_banner -i "$OUT" -af ebur128=peak=true -f null - 2>&1 | grep -E "I:|Peak:" | tail -2
