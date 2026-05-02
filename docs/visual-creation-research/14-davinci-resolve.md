# DaVinci Resolve — Recency Research

> Compiled 2026-05-02. Past-30-day items tagged [NEW]; established but current items tagged [STABLE].

## knowledge[]-ready facts (22)

1. DaVinci Resolve is Blackmagic Design's all-in-one post-production suite combining a non-linear editor, Fusion VFX/compositor, Fairlight DAW, and DaVinci YRGB color science in a single binary.
2. Resolve is organized around seven Pages — Media, Cut, Edit, Fusion, Color, Fairlight, Deliver — and Resolve 21 adds an eighth Photo page for stills grading.
3. DaVinci Resolve Free is unrestricted in time, watermarks, and export length, supports up to 4K UHD at 60fps, and is genuinely production-grade for most independent work.
4. DaVinci Resolve Studio costs $295 USD as a one-time perpetual license with no subscription, and unlocks all Neural Engine AI features, multi-GPU, HDR delivery, OpenFX plugins, and resolutions beyond 4K up to 32K at 120fps.
5. Buying the Speed Editor keyboard (~$395) ships with a Studio activation code, making the keyboard effectively about $100.
6. The current production-stable version is DaVinci Resolve 20.3.2 (Feb 2026), with Resolve 21.0 Beta 2 in public beta as of April 27 2026 — use 20.3.2 for finishing paid work.
7. Resolve 21 (announced 2026-04-14, NAB 2026) introduces a Photo page, IntelliSearch local-AI media search, CineFocus post-production focus rack, AI Face Age Transformer, Face Reshaper, Blemish Removal, Slate ID, Motion Deblur, and AI Speech Generator.
8. The DaVinci Neural Engine is Blackmagic's AI brand, runs locally on the editor's GPU, and is gated to Studio — Free has no AI features.
9. Magic Mask 2 paints a stroke on a person or object and tracks its alpha matte through obstructions for isolated grading or compositing.
10. Fairlight Voice Isolation is a track FX that separates dialogue from background noise (HVAC, traffic, wind) and is one of Resolve's most-cited Studio justifications.
11. Color page grading uses a node tree (parallel, serial, layer, key mixer) with primaries (Lift/Gamma/Gain/Offset wheels) plus secondaries (HSL qualifier + Power Window + tracker).
12. Recommended color science is DaVinci YRGB Color Managed for most work or ACEScct for ACES projects, with a Color Space Transform "sandwich" — input CST → grade → output CST.
13. Fusion is a node-based compositor that reads left-to-right from MediaIn to MediaOut — the inverse philosophy of After Effects' top-down stacked layers and better for branching mattes and reusable effects.
14. The Cut page uses a single source-tape viewer that scrolls all clips as if joined into one tape, optimized for fast assembly and social-media turnaround rather than match-frame precision.
15. Resolve supports multi-user collaboration via Project Server backed by PostgreSQL with bin, timeline, and clip locking — the only NLE with this granular collab model — and it works in Free as well as Studio.
16. The DaVinci Resolve Scripting API is exposed via the DaVinciResolveScript Python module (Studio) or Lua (Free), runnable from the Workspace > Console REPL or as a script in the Utility Scripts folder.
17. Render queue automation uses project.LoadRenderPreset(name), project.AddRenderJob(), and project.StartRendering — but render presets must be created once in the Deliver page UI before they can be called by name from a script.
18. The plugin ecosystem is OpenFX (OFX), Studio-only, with canonical packs Boris FX Sapphire, Boris FX Continuum, FilmConvert Nitrate, Dehancer, Neat Video, and Red Giant Trapcode/Universe — there is no in-app Blackmagic plugin marketplace.
19. DCTL (DaVinci Color Transform Language) is Resolve's GPU-shader language for custom color math; .dctl files drop into the LUT folder and appear as node effects.
20. GPU compute selection in Preferences must match the GPU vendor: Metal on macOS, CUDA on NVIDIA Windows/Linux, OpenCL on AMD Windows/Linux — wrong choice causes "no OpenCL GPU found" errors or massive slowdowns.
21. Color space must be tagged per project or per clip on import — Resolve does NOT auto-detect every camera log, so S-Log3, V-Log, F-Log2, BRAW, and ARRI Log-C clips look wrong until the Input Color Space is set.
22. Hardware control surfaces escalate Micro Panel ($1,000-class, 3 trackballs + 12 knobs) → Mini Panel (adds 2× 5" screens + secondaries deck) → Advanced Panel (broadcast-suite three-surface), with Tangent panels also supported as third-party.
