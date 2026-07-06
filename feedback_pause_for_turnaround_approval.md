---
name: Always Show Gemini Turnarounds Before Running Meshy
description: Show every regenerated character turnaround triplet to the user and get explicit approval BEFORE running the fal.ai Meshy HQ step, since Meshy costs real money per call and a bad cape/skirt/clothing extending into the T-pose arm zone wrecks the Mixamo auto-rig.
type: feedback
originSessionId: 735b5afc-95a7-4172-bd62-c10121462343
---
When regenerating Hermes-male / Hermes-female / future character turnarounds via `scripts/hermes-pipeline/gemini-turnaround.ts`:

1. **Generate the 3 PNGs.**
2. **Read each one** and show them inline to the user.
3. **Wait for explicit approval** before running `scripts/hermes-pipeline/meshy-i2m.ts`.

**Why:** Meshy v6 multi-image-to-3d on fal.ai is paid per request (~$5+ per character). When the user said the male's cape was "too long on the arms", that was on a turnaround pass I shipped to Meshy without showing them first — wasted fal credit and a full pipeline cycle.

**Failure mode to watch for specifically:**
- Long cloak / cape / skirt extending laterally past the shoulders in T-pose arm-span
- Garment fabric touching the arms in front or side view
- Mixamo's auto-rigger reads the arm-wide fabric as part of the shoulder silhouette and produces a flat plank rig with no arm separation
- The "small cape" / "short skirt" must STOP at the shoulders and not extend past the body width

**How to apply:** Use `AskUserQuestion` or a plain "OK to proceed?" pause between Gemini turnaround output and Meshy submission. Never auto-chain the two.
