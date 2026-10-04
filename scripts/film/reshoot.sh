#!/usr/bin/env bash
# Leaderboard reshoot (founder 2026-10-02 ~04:01Z): S2 + S3 + S3 close, HUD off, holds long enough for BOTH
# board pages (house columns 15 s <-> contest leaderboard 15 s). Run from the worktree root AFTER both staging
# containers run tDesk2Main's board commit. Usage: bash scripts/film/reshoot.sh <suffix>   (e.g. 2 -> real-s2-2 ...)
set -u
S="${1:?take suffix}"
R="node scripts/film/film-rig.mjs"
HOLD=33000; SECS=37
$R do scripts/film/steps/tf-prep.mjs
$R do scripts/film/steps/s2v2-setup.mjs
HUD=off $R do scripts/film/steps/hud.mjs
HOLD_MS=$HOLD REAL_STEP=s2-spawn.mjs $R take "real-s2-$S" $SECS scripts/film/steps/real-wrap.mjs
$R do scripts/film/steps/tf-prep.mjs
$R do scripts/film/steps/s3-setup.mjs
HUD=off $R do scripts/film/steps/hud.mjs
HOLD_MS=$HOLD REAL_STEP=s2-spawn.mjs $R take "real-s3-$S" $SECS scripts/film/steps/real-wrap.mjs
$R do scripts/film/steps/tf-prep.mjs
S3C_Z=150 S3C_TILT_KEY=ArrowDown S3C_TILT_MS=300 $R do scripts/film/steps/s3close-setup.mjs
HUD=off $R do scripts/film/steps/hud.mjs
HOLD_MS=$HOLD REAL_STEP=s2-spawn.mjs $R take "real-s3-$((S + 1))" $SECS scripts/film/steps/real-wrap.mjs
for t in "real-s2-$S" "real-s3-$S" "real-s3-$((S + 1))"; do $R check "$t"; done
