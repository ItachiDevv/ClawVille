# BrainChain 3da review response

Date: 2026-11-09. Source correction evidence; visual acceptance remains open.

- B1: frame suppression now checks the service-panel route only. Text focus clears manual keys and touch input without stopping navigation, gravity, or proximity callbacks. A focused textarea on `/game` still advances navigation and calls the movement callback.
- B2: guide approach moves to world (390, -2540). Its complete 12 wu neighborhood stays inside the guide-only talk zone. Both planners reach all eight tested perimeter points exactly.
- B3: player navigation receives a remaining-distance cap. Possessed NPC and 2D Office followers also cap each displacement. A slow sprint frame test proves the player stops exactly at its waypoint.
- N1: a full-mipmap control exists. It uses 963,764 transfer bytes, above the provisional 700 KiB cap. The lead selects this candidate with a provisional 1 MiB transfer cap. The runtime converts Office attributes to Float32 before upload.
- N2: the guide reuses the static lobster plush, one mesh and one material. Its uniform scale fits the 80 wu collider and stays at most 96 wu tall. NPC visibility controls both its figure and label.
- N3: byte prefetch now uses the Office's distance-based prop priority.
- N4: removed the unused exit constant. Back preserves the retained world position; documents now say so.
- N5: controlled unreachable 80,000-expansion searches took 106-157 ms with string keys. Numeric cell keys and typed search arrays reduce warm measurements to 31-44 ms. The cold sample remains 53.569 ms. This desktop benchmark does not establish browser or Iris Xe acceptance. Exact samples live in `navigation-benchmark.json` beside this report.
- N6: selected RDO2 source evidence names 696,692 bytes. The 665,580-byte RDO10 size appears only as a rejected/control comparison. Diagnostic controls do not replace final provenance.
- N7: placement tests now check every land parcel's full AABB clearance.

Verification: 58 web tests pass with 6,692 assertions; shared placement tests pass 5 tests with 212 assertions. Web TypeScript exits zero. The whitespace check passes.

Actual-world final-bundle WebGPU verification remains a separate gate. Service-worker bypass and browser-side byte/hash verification are mandatory for every control. No actual-scene acceptance follows from the isolated WebGL screenshots.

## Second review corrections

B4: collinear node compression preserves every traversed grid cell. A shared polyline helper spends the full frame distance across reached waypoints. Each segment uses its own collision callback, so remainder movement cannot cut a collider corner. Player, possessed NPC, and2D Office followers all use the helper. Tests prove a straight run returns2nodes, a40FPS sprint has no intermediate idle frame, collision stops remainder movement, and the actual player controller keeps moving until arrival.

B5: the BootStreamedContent render prop forwards readiness to the label owner. Both labels use initialVisible and live setVisible state, with finite800/4500fade. Tests verify readiness forwarding and both label contracts.

N5: component labels and generation-stamped arrays persist on the cached grid. A fresh Chrome156 tab measured16.4ms for cold component initialization plus disconnected-query rejection; five subsequent queries measured0ms. The benchmark uses a temporary planner copy with one blocked row before labeling. It does not mutate production geometry or establish Iris Xe timing.

Float32 geometry budgeting and the final mipmapped transfer exception appear in compression-review.md and office-asset-provenance.json. NPC visibility retains the same authoritative collider policy as the Town Guide.

Latest focused verification:67web tests pass with5279assertions. Asset bytes and hash remain unchanged. New-bundle visual and movement checks remain separate gates.

## Third review corrections

B6: the real-player navigation instruction now carries originX/originZ. The helper receives game-pixel points and a game-pixel position. The collision callback subtracts the origin; its result adds the origin back. The position commit subtracts it again. A regression uses origin(11264,11264), negative centered coordinates and translated pixel waypoints. It verifies exact arrival and completion.

D1: the controller records completion during movement and calls it after onAfterMove. The regression changes proximity only in onAfterMove and proves the final entry callback reads the new proximity.

Facing follows the helper's last traversed segment. A fully blocked player frame reports idle and preserves its facing. A blocked NPC also preserves its prior facing. The final waypoint accepts the existing six-unit tolerance; intermediate turns remain precise so tolerance cannot cut corners.

The real-player path needs fresh actual-world evidence. The prior demo NPC walk does not cover this coordinate adapter. Asset format and bytes stay unchanged.

Third-review verification:71web tests pass with5291assertions; web TypeScript exits zero and the whitespace check passes. A blocked turn retains the last segment that actually moved.
