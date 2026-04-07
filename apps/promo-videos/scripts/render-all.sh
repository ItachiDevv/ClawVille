#!/bin/bash
# Batch render all ClawVille promo videos (landscape only for speed)
cd "$(dirname "$0")/.."

mkdir -p out/showcase out/combined out/promo

echo "=== Rendering Showcase Videos (30 landscape) ==="
for id in \
  showcase-ai-lobster-adventure \
  showcase-world-of-clawville \
  showcase-learn-crypto-compete \
  showcase-openclaw-world \
  showcase-knowledge-discovery \
  showcase-bot-exploration \
  showcase-openclaw-arena \
  showcase-arena-bot-training \
  showcase-battle-and-learn \
  showcase-watch-and-learn \
  showcase-spectator-guide \
  showcase-openclaw-spectator \
  showcase-explore-the-depths \
  showcase-your-lobster-journey \
  showcase-arena-ultimate-test \
  showcase-arena-strategy \
  showcase-connect-30-seconds \
  showcase-zero-to-skill \
  showcase-anonymous-play \
  showcase-go-anonymous \
  showcase-create-account \
  showcase-account-benefits \
  showcase-complete-walkthrough \
  showcase-new-player-to-master \
  showcase-daily-rewards \
  showcase-quest-system \
  showcase-clawtoken-economy \
  showcase-lobster-personalities \
  showcase-npc-memory \
  showcase-skill-marketplace
do
  echo "Rendering $id..."
  bunx remotion render "${id}-landscape" "out/showcase/${id}-landscape.mp4" 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "  FAILED: $id"
  fi
done

echo ""
echo "=== Rendering Combined Videos (14 landscape) ==="
for id in \
  c01-create-your-lobster \
  c02-explore-the-depths \
  c03-connect-your-agent \
  c04-agent-explores-autonomously \
  c05-agents-learn-from-npcs \
  c06-leave-agent-to-learn \
  c07-arena-combat \
  c08-train-agent-in-battle \
  c09-spectate-agent-battles \
  c10-build-export-skills \
  c11-clawtoken-economy \
  c12-quests-and-progression \
  c13-get-started-free \
  c14-agent-learning-pipeline
do
  echo "Rendering $id..."
  bunx remotion render "${id}-landscape" "out/combined/${id}-landscape.mp4" 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "  FAILED: $id"
  fi
done

echo ""
echo "=== Rendering Promo Videos (3 landscape) ==="
for id in \
  promo-skill-creation \
  promo-arena-gameplay \
  promo-clawville-combined
do
  echo "Rendering $id..."
  bunx remotion render "${id}-landscape" "out/promo/${id}-landscape.mp4" 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "  FAILED: $id"
  fi
done

echo ""
echo "=== Summary ==="
echo "Showcase: $(ls out/showcase/*.mp4 2>/dev/null | wc -l) files"
echo "Combined: $(ls out/combined/*.mp4 2>/dev/null | wc -l) files"
echo "Promo: $(ls out/promo/*.mp4 2>/dev/null | wc -l) files"
echo "Individual: $(ls out/v*.mp4 2>/dev/null | wc -l) files"
echo "TOTAL: $(find out -name '*.mp4' | wc -l) files"
