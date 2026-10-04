#!/usr/bin/env bash
# Every clip in the arena demo v1, cut from the real takes in ../.film/takes (staging 2eaace16, 2026-10-02 02:28-03:07Z).
# Speed and crop only. Footage times = rig.log time - rec start + 0.25 s (UI lag, filmitHelper map 2026-10-02). Crops are 16:9 boxes in source px (1920x1080), scaled up with lanczos.
# real-s6 crop stops at y 690: the "Recent trades" list below holds a coin name we keep out of the asset.
# real-s9 shows only the SCAN + STATUS rows as a band (y 130-270); the rest of the panel is a heavy blur.
set -euo pipefail
cd "$(dirname "$0")"
T=../.film/takes
O=composition/assets/clips
mkdir -p "$O"
ENC="-an -c:v libx264 -preset medium -crf 16 -pix_fmt yuv420p -r 30 -movflags +faststart"
UP="scale=1920:1080:flags=lanczos,unsharp=5:5:0.5"
P="crop=1030:580:440"   # panel crop: x 440..1470, then :<y0>

cut() { # name src in dur vf
  ffmpeg -hide_banner -loglevel error -y -ss "$3" -t "$4" -i "$T/$2.mp4" -vf "$5,fps=30" $ENC "$O/$1.mp4"
  echo "$1 <- $2 @$3 +$4"
}

cut hook     real-s1          0.6   3.8  "crop=1156:650:352:0,$UP"
cut floor    real-s2-2        1.5   6.2  "null"   # 04:40Z take: big board house page (0-8.5 s)
cut five     real-s5a         0.24  7.5  "null"   # 1x: the source is ~32 fps effective, slow motion stutters
cut review   real-s6          13.15 4.2  "$P:110,$UP"   # report hold 13.10-18.25 s (after the scroll)
cut pivot    real-s7          5.84  4.0  "null"   # ends before the modal half-open frames (9.85 s)
cut form     real-s7          14.55 3.4  "$P:200,$UP"   # ends before Step 3 (18.08 s)
cut lock     real-s7          10.1  3.7  "$P:230,$UP"
cut mode     real-s7          10.1  2.2  "$P:230,$UP"
cut launch   real-s7          23.86 2.24 "$P:290,$UP"
# success: frame 1566 = the first "Reef Rookie is ready" frame; only the card (source y 120-330) stays sharp
ffmpeg -hide_banner -loglevel error -y -ss 26.10 -t 2.95 -i "$T/real-s7.mp4" -filter_complex "[0:v]crop=1030:580:440:120,scale=1920:1080:flags=lanczos,unsharp=5:5:0.5,split[a][b];[a]boxblur=26:3,eq=brightness=-0.3[bl];[b]crop=1920:392:0:0[top];[bl][top]overlay=0:0,fps=30" $ENC "$O/success.mp4"; echo "success <- real-s7 @26.10 +2.95 (card sharp, rest blurred)"
cut seat     real-s8          4.45  3.62 "null"   # ends before the My trader panel fades in (src 8.07)
cut quote    real-s3-3        3.0   6.2  "scale=1920:1080:flags=lanczos"   # close board, leaderboard page 2.17-17.17 s, Reef Rookie #2 (source 1920x1078)
cut board    real-s10-after-2 2.9   3.8  "$P:140,$UP"
# contest banner: only the banner (source y 120-430) stays sharp; the stale pre-launch board below is blurred
ffmpeg -hide_banner -loglevel error -y -ss 1.9 -t 3.6 -i "$T/real-s11.mp4" -filter_complex "[0:v]crop=1030:580:440:120,scale=1920:1080:flags=lanczos,unsharp=5:5:0.5,split[a][b];[a]boxblur=26:3,eq=brightness=-0.3[bl];[b]crop=1920:578:0:0[top];[bl][top]overlay=0:0,fps=30" $ENC "$O/contest.mp4"; echo "contest <- real-s11 @1.9 +3.6 (banner sharp, board blurred)"
cut rules    real-s11         6.1   6.88 "$P:120,$UP,tpad=stop_mode=clone:stop_duration=2"   # last frame held 2 s
cut button   real-s2-2        25.0  2.0  "crop=1300:731:310:0,$UP"

# the decision stream as a band over its own heavy blur
ffmpeg -hide_banner -loglevel error -y -ss 2.55 -t 4.2 -i "$T/real-s9.mp4" -filter_complex \
  "[0:v]split[a][b];[a]boxblur=26:3,eq=brightness=-0.18[bg];[b]crop=1030:140:440:130,scale=1920:261:flags=lanczos,unsharp=5:5:0.5[st];[bg][st]overlay=0:410,fps=30" \
  $ENC "$O/stream.mp4"
echo "stream <- real-s9 @2.55 +6.8 (4.2 s; band y 130-270; rows static after the scroll ends at 2.5 s)"
