#!/bin/bash
# Drive the full controlled-mode game flow against a live ClawVille pair.
# Runs inside WSL with HermesAgent already paired.

CV=/home/itachi/.hermes/skills/integrations/clawville/scripts/clawville.py
PY=/usr/bin/python3
cd /home/itachi

echo "=== balance ==="
$PY "$CV" balance
echo ""

echo "=== shop at cron-automation ==="
$PY "$CV" shop cron-automation | head -14
echo ""

echo "=== buy cron-automation-basics ==="
$PY "$CV" buy cron-automation-basics
echo ""

echo "=== read cron-automation-basics ==="
$PY "$CV" read cron-automation-basics | head -6
echo ""

echo "=== sync to install the skill folder ==="
$PY "$CV" sync 2>&1 | tail -8
echo ""

echo "=== verify install ==="
ls /home/itachi/.hermes/skills/clawville-cron-automation/ 2>&1
echo "--- scripts/ ---"
ls /home/itachi/.hermes/skills/clawville-cron-automation/scripts/ 2>&1
echo "--- SKILL.md head ---"
head -7 /home/itachi/.hermes/skills/clawville-cron-automation/SKILL.md 2>&1
echo "--- tools.json declares ---"
$PY -c "import json; t=json.load(open('/home/itachi/.hermes/skills/clawville-cron-automation/tools.json')); print([x['name'] for x in t])"
