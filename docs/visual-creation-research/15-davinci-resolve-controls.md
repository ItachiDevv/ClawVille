# DaVinci Resolve — Durable Anchor Knowledge (Round 2)

> Recency-agnostic. Page architecture, node graph models, color science, audio routing, the keyboard map.

## knowledge[]-ready facts (30)

### Pages
1. DaVinci Resolve is a seven-page workspace — Media, Cut, Edit, Fusion, Color, Fairlight, Deliver — switched with Shift+2 through Shift+8 (modern installs).
2. The Cut page is BMD's fast-edit workspace built around a single dual-mode viewer, Source Tape (Cmd+8), Sync Bin for auto-multicam, and four canonical edit buttons: Smart Insert, Append, Place On Top, Source Overwrite.
3. The Edit page is the conventional NLE with Source/Timeline viewers, stacked V/A tracks, and three-point editing where Mark In/Out + F9 inserts, F10 overwrites, F11 replaces, F12 places-on-top.

### Shortcuts
4. Resolve's Edit-page tool keys are A Selection, B Blade, T Trim Edit, W Dynamic Trim — different from Premiere defaults — with N toggling snapping and V selecting clip under playhead.
5. JKL is Resolve's universal shuttle (J reverse, K stop, L forward, taps multiply speed); comma/period nudge ±1 frame; Up/Down jump prev/next edit; Home/End jump to timeline ends.
6. In Resolve I/O set in/out points; Alt+I and Alt+O clear them; M adds a marker; Cmd+B blades at playhead; Cmd+R opens speed/duration; Cmd+T adds the default video transition.
7. Resolve Color-page node shortcuts: Alt+S adds a Serial node, Alt+P adds a Parallel node, Alt+L adds a Layer node, Alt+O adds an Outside node; Cmd+Y / Cmd+B step through clip versions; Cmd+Opt+G grabs a Still.

### Color grading
8. The Color page is node-based with four node types: Serial (sequential), Parallel (additive sum via Parallel Mixer), Layer (composite-mode stack via Layer Mixer), Outside (inverts the upstream alpha to grade everything *outside* a key/window).
9. Resolve has six Hue-vs / Sat-vs curves: Hue vs Hue, Hue vs Sat, Hue vs Lum, Lum vs Sat, Sat vs Sat, Sat vs Lum — the secondary-correction toolbox that doesn't require a qualifier pull.
10. The HSL Qualifier is Resolve's eyedropper-driven secondary key — pick a color, refine Hue/Sat/Lum range strips, view the matte with Highlight (Cmd+Shift+H), and clean it with Pre-Filter / Blur / matte Denoise.
11. Power Windows (Linear, Circle, Polygon, Curve/BSpline, Gradient) are shape-based masks combined with the Tracker (1/2/3/4-point + Cloud + Point + Planar) for follow-the-subject grading.
12. PowerGrades are Resolve Gallery items shared across every project in the same database; Stills are project-local; middle-clicking a clip thumbnail in the Color page copies that clip's grade to the currently-selected clip.

### Fusion compositing
13. Fusion node graphs read LEFT to RIGHT (opposite of After Effects' top-down stack); Merge nodes are the universal compositor with yellow Background input setting output resolution and green Foreground input composited by alpha.
14. Every Fusion tool has a blue Effect Mask input — wire any mask-producing node into it to alpha-restrict that tool's effect.
15. Fusion offers four trackers: Tracker (1–4 point), Planar Tracker (surface), Camera Tracker (3D camera solve from 2D footage), and Steady (one-button stabilizer); plus a particle system (pEmitter/pImageEmitter/pSpawn/pCustom/pRender) and a 3D pipeline (Image Plane 3D + Camera 3D + Renderer 3D).
16. Fusion Macros package a sub-graph as a single re-usable node by right-clicking a selection → Macro → Create Macro, with chosen parameters exposed.

### Fairlight
17. Fairlight is a full DAW with FlexBus routing — each track outputs to up to 10 busses + 10 sends, busses can route to busses up to 6 layers deep, enabling stem trees from Mono/Stereo through 5.1/7.1 to immersive 9.1.6 Atmos.
18. Fairlight FX is the bundled plugin suite (Compressor, Limiter, Gate, De-Esser, De-Hummer, Reverb, Echo, Pitch, Vocal Channel, Multiband Compressor) plus VST/AU support — Resolve does not host AAX.
19. The Fairlight loudness meter reports LUFS Integrated/Short/Momentary, LU range, and True Peak per ITU-R BS.1770-4, EBU R128, and ATSC A/85.

### Color management
20. Resolve's four color-management modes are DaVinci YRGB (legacy scene-referred), DaVinci YRGB Color Managed (DRM — auto IDT/ODT pipeline), ACES (ACEScct working space with ACES IDTs/ODTs), and DaVinci Wide Gamut Intermediate (BMD-recommended HDR-ready working space inside DRM).
21. The Color Space Transform (CST) is a node-graph tool you drop on individual clips to do per-clip color-space transforms — the bridge for clips that don't fit the project's DRM/ACES setup.

### Project Server
22. Resolve's pro multi-user setup is the Project Server: a dedicated always-on machine running PostgreSQL on TCP 5432, with workstations connecting via the Project Manager and per-bin/per-timeline locking under File > Collaboration.

### OFX / DCTL / ResolveFX
23. DCTL (DaVinci Color Transform Language) is Resolve's GPU-compiled C-like shader language for custom color effects — `.dctl` plain text or `.dctle` encrypted, applied as a LUT or via OpenFX > Filters > ResolveFX Color > DCTL, with Transform and Transition flavors.
24. ResolveFX is the bundled BMD effects library (Beauty, Face Refinement, Lens Flare, Lens Reflections, Light Rays, Smear, Texture Pop, Vignette, Despill, etc.) with a free subset and a Studio-only superset, all hosted under OpenFX > Filters.

### Templates
25. In Resolve, Compound Clip = a nested timeline collapsed to one clip; Fusion Clip = a Compound Clip routed through a Fusion comp; Adjustment Clip = transparent timeline clip whose effects apply to all clips on lower V tracks (the adjustment-layer equivalent).
26. Smart Bins are saved metadata searches (auto-update); Power Bins are project-wide bins shared across every timeline (graphics, music beds, lower-third templates).

### Recipes / hidden features
27. Source Tape (Cut page, Cmd+8) presents every clip in a bin as one continuous virtual reel for fast scrubbing through hours of footage.
28. Sync Bin (Cut page) auto-displays only clips that overlap the playhead by timecode, enabling fast multicam cuts without explicitly creating multicam clips.
29. Color Trace copies grades from one timeline to a re-conformed/renamed timeline by matching source timecode + clip name — the canonical post-VFX-bake or post-conform reapply workflow.
30. Quick Export (top-right of every page, also File > Quick Export) bypasses the Resolve Deliver page for one-click YouTube/Vimeo/H.264 render of the current timeline.
