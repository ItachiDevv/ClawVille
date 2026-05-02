# Adobe Premiere Pro — Durable Working-Editor Reference (Round 2)

> Anchor knowledge complement to `09-premiere-pro-2026.md`. Recency-agnostic.

## knowledge[]-ready facts (53)

### Shortcuts
1. Premiere's selection tool is V, razor is C, ripple-edit is B, rolling-edit is N, slip is Y, slide is U, type is T, pen is P, hand is H, zoom is Z.
2. Cmd+K cuts the timeline at the playhead on every targeted track, while Cmd+Shift+K cuts across all tracks regardless of targeting.
3. The canonical Premiere shuttle is J reverse, K stop, L forward, with J-J or L-L doubling speed and K + J/L frame-stepping.
4. I and O mark in/out, X marks the entire clip under the playhead, / marks the sequence, and Cmd+Shift+I/O clears in/out.
5. Insert is `,` and overwrite is `.` in Premiere's default keymap, while `;` lifts and `'` extracts the in-to-out range.
6. Q ripple-trims the previous edit to the playhead and W ripple-trims the next edit, both fired only on targeted tracks.
7. Cmd+L toggles linkage between selected audio and video clips; Cmd+R opens Speed/Duration; Cmd+G groups; Shift+E enables/disables clips.
8. Cmd+D applies the default video transition (Cross Dissolve), Cmd+Shift+D applies the default audio transition (Constant Power), Shift+D applies both.
9. M adds a marker at the playhead, Shift+M jumps to the next marker, and Cmd+Shift+M jumps to the previous.
10. F performs Match Frame, jumping the Source Monitor to the exact frame under the program playhead with the source clip's in/out preserved.

### Panels
11. The Project panel holds clips, sequences, bins, adjustment layers, color mattes, titles, and captions; the Source Monitor previews a single project asset.
12. The Effect Controls panel exposes Motion, Opacity, and Time Remapping by default plus every applied effect's keyframable parameters.
13. The Audio Track Mixer affects entire tracks (faders, sends, automation), while the Audio Clip Mixer affects only the clip currently under the playhead.
14. The Reference Monitor is a second Program Monitor used for split-screen color matching and shot comparison.
15. The Media Browser is the correct entry point for camera-card structures (RED, ARRI, P2, XDCAM, BRAW) so spanned clips and metadata are preserved.

### Effects
16. Lumetri Color is the modern primary grading effect; Fast Color Corrector and Three-Way Color Corrector remain only for backward compatibility.
17. Ultra Key is Premiere's primary chroma keyer, with sections for Matte Generation, Matte Cleanup, Spill Suppression, and Color Correction.
18. Track Matte Key uses any track's luma or alpha to mask the clip it's applied to; Image Matte Key uses an external still image as a mask.
19. Warp Stabilizer requires a background analyze pass and offers Smooth Motion, No Motion, and Subspace Warp modes for handheld stabilization.
20. The Transform effect supports motion blur, while Premiere's built-in Motion (in Effect Controls) does not.

### Transitions
21. Cross Dissolve is the default video transition, used for ~95% of dissolves; Dip to Black signals time/scene change; Dip to White signals reveal/flash.
22. Morph Cut is the AI face-warp transition designed to hide jump cuts in talking-head edits.
23. Constant Power is the default audio transition because it preserves perceived energy across the crossfade, unlike Constant Gain which dips in the middle.
24. Gradient Wipe is the most flexible wipe transition because it accepts any black-and-white image as a wipe map.

### Lumetri
25. Lumetri's six sections in stack order are Basic Correction, Creative, Curves, Color Wheels & Match, HSL Secondary, and Vignette.
26. The canonical Lumetri Basic order is white balance (eyedropper, then Temp/Tint), then Tone (Exposure, Contrast, Highlights, Shadows, Whites, Blacks), then Saturation.
27. HSL Secondary is the standard tool for isolating a hue range (skin, sky, grass) and grading only the keyed area.
28. Lumetri's Color Match uses a reference frame plus a target frame and an Apply Match button, with optional Face Detection to weight the match toward skin.
29. The Vectorscope's "skin tone line" runs from the center toward 11 o'clock, and aligning faces along it is the standard skin-tone check.

### Audio
30. Premiere supports Standard, Mono, 5.1, and Adaptive (up to 32-channel) tracks, with Adaptive routing controlled per-clip via Audio Channels.
31. Track automation modes are Off, Read, Latch, Touch, and Write, with Touch the safest for live-mixing because it returns to prior automation when released.
32. Audio Gain is pre-fader and applied before clip volume keyframes, accessed by right-click > Audio Gain or G.
33. The Essential Sound panel tags clips as Dialogue, Music, SFX, or Ambience and exposes preset processing chains and Auto-Duck per tag.
34. The pro audio routing pattern groups all dialogue tracks to a Submix with Hum Reduction → DeNoise → DeEsser → EQ → Compressor → Limiter rather than chaining processors per track.

### Color Management
35. Premiere's three Color Management modes are Direct (legacy, no transform), Lumetri (Rec.709 SDR or Rec.2100 HDR managed), and ACES (working in ACEScct with IDT and RRT+ODT).
36. Lumetri color management is the right pick for modern SDR/HDR delivery; ACES is for multi-camera VFX-heavy projects intercutting with After Effects/Resolve/Nuke.

### Markers
37. Premiere supports Comment, Chapter, Segmentation, Web Link, and Flash Cue Point marker types, each with optional duration and color.
38. Markers can be exported as .csv, .txt, .html, or .xml via File > Export > Markers, and are independent of captions, which export as .srt/.vtt/.scc/.stl/embedded 608/708.

### Export
39. The three export paths are Direct Export (Cmd+M), Send to Adobe Media Encoder (Cmd+Opt+M), and Quick Export (top-right arrow icon).
40. Two-pass VBR yields the best quality at a given bitrate target and is the default for archive masters; CBR is preferred when a streaming/broadcast bitrate ceiling must not be exceeded.
41. ProRes 422 HQ is the canonical mastering codec on macOS, ProRes 4444 the canonical VFX-intermediate with alpha, and DNxHR HQ the canonical cross-platform mezzanine.
42. Match Source copies the sequence's frame size, frame rate, field order, and aspect to the export but does not change the codec.

### Recipes
43. A three-point edit requires three of {source-in, source-out, timeline-in, timeline-out}; Premiere computes the fourth.
44. To smooth slow-motion below 50% speed, set Time Interpolation to Optical Flow (right-click clip), then change Speed/Duration; render in to out for accurate preview.
45. Right-click clip > Add Frame Hold freezes from the playhead onward, while Insert Frame Hold Segment inserts a 2-second held segment without disturbing the rest.
46. The canonical green-screen recipe is Ultra Key > eyedropper on green > Output Composite > tighten Matte Generation/Cleanup > add a Mask shape on the effect as a garbage matte.

### Multicam
47. Multi-Camera Source Sequences sync by In Points, Out Points, Timecode, Markers, or Audio waveform; Audio is the default in modern projects.
48. With multicam display enabled (0 on the timeline), keys 1–9 cut between angles during live playback, and right-click > Multi-Camera > Flatten replaces the multicam with the chosen-angle clips.

### Organization
49. Premiere's Project search supports column-aware queries (name:, description:, tape:) and can be saved as a Search Bin that updates as new matching clips are imported.
50. Label Defaults (Preferences > Label Defaults) and Label Colors (Preferences > Label Colors) let you assign a per-asset-type color scheme (e.g. Bin tan, Video blue, Audio green, Adjustment Layer orange) that propagates to every new clip.

### Workspace / Power-User
51. Workspaces save panel layout (Editing, Color, Effects, Audio, Captions and Graphics, Production, Review) but not keyboard shortcuts; keyboard shortcuts live in Edit > Keyboard Shortcuts and have their own Keyboard Mapping presets.
52. Source Patching (left-side blue rectangles on track headers) determines which source channels go to which timeline tracks on insert/overwrite; Track Targeting (right-side rectangles) determines where keyboard-shortcut edits land.
53. The QE DOM (app.enableQE() then qe.project) is Premiere's undocumented internal scripting object model that exposes track manipulation, codec preset access, and other functionality the public ExtendScript DOM does not.
