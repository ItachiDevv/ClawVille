#!/bin/bash
# Generate MP4 recordings from game screenshots using ffmpeg zoompan (Ken Burns effect)
# Each screenshot becomes a 20-30s video with smooth zoom/pan animation

SRCDIR="$HOME/Downloads"
OUTDIR="$(dirname "$0")/../public/recordings"
mkdir -p "$OUTDIR"

# Source images
GAME1="$SRCDIR/game-world-01.png"
GAME2="$SRCDIR/game-world-02.png"
GAME3="$SRCDIR/game-world-03.png"
ARENA1="$SRCDIR/arena-01.png"

FPS=30
W=1920
H=1080

# Helper: create Ken Burns MP4 from image
# $1=input $2=output $3=duration_seconds $4=zoom_direction (in|out) $5=pan (left|right|center|up)
ken_burns() {
  local input="$1" output="$2" dur="$3" zdir="$4" pan="$5"
  local frames=$((dur * FPS))

  # Zoom expressions
  local zoom_expr pan_x_expr pan_y_expr

  case "$zdir" in
    in)
      zoom_expr="zoom+0.001"
      ;;
    out)
      zoom_expr="if(eq(on,1),1.5,zoom-0.001)"
      ;;
    slow_in)
      zoom_expr="zoom+0.0005"
      ;;
  esac

  case "$pan" in
    left)
      pan_x_expr="iw/2-(iw/zoom/2)+on*2"
      pan_y_expr="ih/2-(ih/zoom/2)"
      ;;
    right)
      pan_x_expr="iw/2-(iw/zoom/2)-on*2"
      pan_y_expr="ih/2-(ih/zoom/2)"
      ;;
    up)
      pan_x_expr="iw/2-(iw/zoom/2)"
      pan_y_expr="ih/2-(ih/zoom/2)+on*1.5"
      ;;
    down)
      pan_x_expr="iw/2-(iw/zoom/2)"
      pan_y_expr="ih/2-(ih/zoom/2)-on*1.5"
      ;;
    center)
      pan_x_expr="iw/2-(iw/zoom/2)"
      pan_y_expr="ih/2-(ih/zoom/2)"
      ;;
    topleft)
      pan_x_expr="on*1"
      pan_y_expr="on*0.8"
      ;;
    bottomright)
      pan_x_expr="iw-(iw/zoom)-on*1"
      pan_y_expr="ih-(ih/zoom)-on*0.8"
      ;;
  esac

  echo "Creating $output (${dur}s, zoom=$zdir, pan=$pan)..."
  ffmpeg -y -loop 1 -i "$input" \
    -vf "zoompan=z='${zoom_expr}':x='${pan_x_expr}':y='${pan_y_expr}':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p" \
    -c:v libx264 -preset fast -crf 23 -t "$dur" \
    "$output" 2>/dev/null
}

echo "=== Generating Game World Recordings ==="

# Game world exploration videos (from game screenshots)
ken_burns "$GAME1" "$OUTDIR/game-world-exploration-npcs.mp4" 25 "slow_in" "right"
ken_burns "$GAME2" "$OUTDIR/game-explore-buildings.mp4" 25 "in" "left"
ken_burns "$GAME3" "$OUTDIR/game-building-chat-learn.mp4" 22 "in" "topleft"
ken_burns "$GAME1" "$OUTDIR/game-pet-chat-shop.mp4" 22 "out" "center"
ken_burns "$GAME2" "$OUTDIR/game-openclaw-connect.mp4" 22 "slow_in" "up"
ken_burns "$GAME3" "$OUTDIR/game-openclaw-skills.mp4" 22 "in" "bottomright"
ken_burns "$GAME1" "$OUTDIR/game-menu-skills-inventory.mp4" 20 "out" "left"
ken_burns "$GAME2" "$OUTDIR/world-exploration.mp4" 25 "slow_in" "right"
ken_burns "$GAME3" "$OUTDIR/building-chat.mp4" 22 "in" "center"
ken_burns "$GAME1" "$OUTDIR/openclaw-connect.mp4" 22 "out" "up"

# Feature-specific game videos
ken_burns "$GAME2" "$OUTDIR/daily-rewards.mp4" 18 "in" "center"
ken_burns "$GAME3" "$OUTDIR/shop-books.mp4" 18 "slow_in" "left"
ken_burns "$GAME1" "$OUTDIR/pet-stats.mp4" 18 "out" "center"
ken_burns "$GAME2" "$OUTDIR/npc-activity.mp4" 20 "in" "right"

echo "=== Generating Arena Recordings ==="

# Arena videos (from arena screenshot)
ken_burns "$ARENA1" "$OUTDIR/arena-overview-pan.mp4" 30 "slow_in" "right"
ken_burns "$ARENA1" "$OUTDIR/arena-combat-closeup.mp4" 25 "in" "topleft"
ken_burns "$ARENA1" "$OUTDIR/arena-kills-respawns.mp4" 22 "in" "bottomright"
ken_burns "$ARENA1" "$OUTDIR/arena-battle-royale.mp4" 30 "out" "center"
ken_burns "$ARENA1" "$OUTDIR/arena-connect-settings.mp4" 18 "slow_in" "up"

echo "=== Done! ==="
ls -la "$OUTDIR"/*.mp4 2>/dev/null | wc -l
echo "MP4 files created"
