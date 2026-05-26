#!/bin/bash
# Final verification: balance fix + live tool dispatch via the installed skill folder.
# Assumes WSL Hermes is already paired (sessionId persists from prior step).

CV=/home/itachi/.hermes/skills/integrations/clawville/scripts/clawville.py
PY=/usr/bin/python3
cd /home/itachi

# Sync the latest script from Windows-mounted repo into WSL Hermes
cp "/mnt/c/Users/newma/Documents/Crypto/ClawVille/integrations/hermes/scripts/clawville.py" "$CV"
chmod +x "$CV"

echo "=== balance (fixed shape — uses /wallet + /stats) ==="
$PY "$CV" balance
echo ""

echo "=== invoke cron_describe via master clawville.py ==="
$PY "$CV" tool cron-automation cron_describe --json '{"expression":"*/15 * * * *"}'
echo ""

echo "=== invoke cron_describe via the installed PER-SKILL shim (Hermes calls this) ==="
$PY /home/itachi/.hermes/skills/clawville-cron-automation/scripts/run.py cron_describe '{"expression":"0 9 * * 1-5"}'
echo ""

echo "=== invoke cron_next_fires (5 weekday 9am UTC fires) ==="
$PY "$CV" tool cron-automation cron_next_fires --json '{"expression":"0 9 * * 1-5","count":5}'
echo ""

echo "=== verify Hermes config sees the new skill folder ==="
ls /home/itachi/.hermes/skills/clawville-cron-automation/ 2>&1
echo "---"
echo "Skills folder contents matching clawville-*:"
ls -d /home/itachi/.hermes/skills/clawville-* 2>&1
