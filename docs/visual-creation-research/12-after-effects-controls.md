# Adobe After Effects — Durable Working-Motion-Designer Reference (Round 2)

> Anchor knowledge complement to `08-after-effects-2026.md`. Recency-agnostic.

## knowledge[]-ready facts (52)

### Shortcuts
1. In After Effects, the property reveal letters are P (Position), S (Scale), R (Rotation), T (Opacity = Transparency), A (Anchor Point), M (Mask Path), with Shift+letter adding to the visible list instead of replacing it.
2. U reveals all keyframed properties on the selected layer, and pressing U twice (UU) reveals every modified property — the fastest way to reverse-engineer someone else's project.
3. F9 applies Easy Ease to selected keyframes, Shift+F9 is Easy Ease In, Cmd+Shift+F9 is Easy Ease Out, and Cmd+Alt+K opens the Keyframe Velocity dialog for numeric influence.
4. Cmd+Shift+C pre-composes selected layers (the most-used compositing move), Cmd+Shift+D splits a layer at the playhead, and Cmd+Alt+Shift+S is Increment and Save.
5. B and N set the work area In and Out points to the current time, and Cmd+Shift+X trims the comp to the work area.
6. The Y key activates the Pan Behind / Anchor Point tool, which is the only correct way to move the anchor without moving the layer's apparent position.
7. Holding Spacebar from any tool temporarily activates the Hand tool to pan the viewer, and Caps Lock freezes viewer refresh — invaluable while scrubbing complex comps.
8. Cmd+M adds the active comp to the AE Render Queue and Cmd+Alt+M adds it to Adobe Media Encoder Queue.

### Properties
9. Every layer in After Effects has a Transform group with Anchor Point, Position, Scale, Rotation, and Opacity — and 3D layers add separate X / Y / Z Rotation plus Orientation (which always takes the shortest path).
10. Right-click Position → Separate Dimensions splits Position into per-axis properties so X and Y can have completely different keyframe timing/easing.
11. Time Remap is enabled per-layer with Cmd+Alt+T and produces two keyframes (at In and Out) which you can drag, duplicate, or hold to retime — including freeze-frames by duplicating one keyframe in place.
12. The pickwhip is the spiral icon next to any property's expression area; dragging from it onto another property automatically writes the JS expression path to wire them together.

### 3D
13. The "sun" switch on a layer is Continuously Rasterize for vector layers (Illustrator/PDF/text/shapes — keeps them crisp at any scale) and Collapse Transformations for nested compositions (preserves vector quality across nesting but breaks blend modes and certain effects).
14. Two-Node cameras have a Point of Interest the camera always faces; parent the POI to a null and you have a steerable camera rig in 30 seconds.
15. The four AE light types are Parallel (sun-like, position only sets direction), Spot (cone with angle + feather), Point (radiates equally), and Ambient (no position, global fill); every light has Casts Shadows / Shadow Darkness / Shadow Diffusion controls.
16. AE 3D renderer choice is Composition Settings → 3D Renderer: Classic 3D (flat layers in space, fastest), Cinema 4D (legacy extruded text/shapes), or Advanced 3D (modern successor with environment lighting and proper shadow casting on extruded geometry).

### Effects
17. Keylight 1.2 is the production-grade green-screen keyer in After Effects, and the standard pipeline is Keylight → Advanced Spill Suppressor → Refine Soft/Hard Matte → Matte Choker.
18. Fractal Noise is the workhorse procedural texture in AE — clouds, smoke, energy, and the source of countless displacement-driven effects — and Turbulent Noise is its cheaper variant.
19. Trim Paths is the single most-used shape operator: every "draw-on" line, circular progress bar, and handwriting reveal is Trim Paths animating Start / End / Offset.
20. The Stroke effect ("paint along a mask path") combined with a closed mask + Paint Style = Reveal Original Image is the canonical handwriting reveal recipe before shape layers existed.
21. Warp Stabilizer is the post-tracking footage stabilizer (Subspace Warp by default) and is found under the Distort effect group, not a menu item.
22. The 3D Camera Tracker is found under Effect → Perspective → 3D Camera Tracker (or Animation → Track Camera) and creates a real AE camera plus null targets you parent layers to.
23. Glow with Glow Threshold ~50%, Glow Radius ~30, applied twice (one tight, one wide), is the canonical bloom-on-text look in motion graphics.
24. Lumetri Color is the modern grading panel in AE (the same engine as Premiere) and should replace ad-hoc Brightness/Contrast + Curves stacks for any serious color work.

### Expressions
25. wiggle(freq, amp) produces smooth random motion at freq wiggles per second with peak amplitude amp, and is the most-used expression in After Effects.
26. loopOut("cycle"), loopOut("pingpong"), loopOut("continue"), and loopOut("offset") are the four loop modes that extend keyframed animation forever past the last keyframe with no extra keyframes.
27. Expression Controls (Slider / Color / Checkbox / Layer / Point / Angle / Dropdown / 3D Point) are effects that render nothing but expose values for expressions to read via effect("Name")("Slider") — the basis of every "master controller" rig.
28. Alt-clicking a property's stopwatch toggles its expression, and EE reveals only the expressions on the selected layer (vs E which reveals all effects).

### Shape Layers
29. Shape layer operators (Repeater, Trim Paths, Wiggle Paths, Pucker & Bloat, Twist, Round Corners, Offset Paths, Zig Zag, Merge Paths) execute top-down within their group, and reordering Trim Paths above vs below Repeater produces wildly different results.
30. The Pen tool draws a mask when a layer is selected and a shape layer when nothing is selected — same tool, different behavior driven by selection state.

### Text Animators
31. Text animators have Selectors (Range / Wiggly / Expression) that define WHICH characters change and Properties (Position/Scale/Rotation/Opacity/Fill/Stroke/Tracking/Blur/etc.) that define WHAT changes per character.
32. Animating Range Selector → Offset from -100 to 100 with Advanced → Shape = Ramp Up + a Scale property of [0,0] is the canonical "characters scale-in one by one" recipe.

### Masks
33. Masks have Mode (None/Add/Subtract/Intersect/Lighten/Darken/Difference), Inverted, Feather, Opacity, and Expansion; MM reveals all four animatable properties at once.
34. Pickwhipping Position to a Mask Path causes the layer to ride along that path — animate Position 0–100% along the path's length.
35. RotoBezier mode auto-computes vertex tangents from neighbors (good for organic shapes); turn it off for precision logo-style masks.

### Mattes & Modes
36. Track matte modes are Alpha / Alpha Inverted / Luma / Luma Inverted, and the matte layer above is automatically toggled invisible when consumed.
37. Stencil Alpha and Silhouette Alpha are AE-specific blend modes that make a layer cut a window (Stencil) or hole (Silhouette) into ALL layers below, not just the layer directly underneath.
38. Preserve Underlying Transparency makes a layer visible only where layers BELOW have alpha — the inverse of a track matte and useful for overlay effects on existing shapes.

### Cameras & Lights
39. The look-at expression `lookAt(thisLayer.toWorld(thisLayer.transform.anchorPoint), thisComp.layer("Target").toWorld([0,0,0]))` on Orientation makes any 3D layer aim at any other 3D layer.
40. The "light wrap" compositing recipe (duplicated bg, alpha-matted to fg, heavily blurred, set to Screen, low opacity) is what makes a green-screen key look photographed.

### Recipes
41. The standard slideshow recipe is: drop images on the timeline, then Animation → Keyframe Assistant → Sequence Layers with overlap = 1s and Cross Dissolve enabled.
42. To enable motion blur on a layer you must turn on BOTH the per-layer motion-blur switch AND the comp-level Motion Blur master switch, then tune Shutter Angle (180° = realistic) under Composition Settings → Advanced.
43. To freeze a frame, enable Time Remap (Cmd+Alt+T), then place two keyframes with the same value spanning the freeze duration, OR right-click the layer → Time → Freeze Frame.

### Render Queue
44. Render Queue separates Render Settings (left side: quality, resolution, time span, motion blur, frame blending) from Output Module (right side: format, codec, channels, color depth, color management, audio output).
45. Color = Premultiplied (Matted) is what most NLEs expect; Color = Straight (Unmatted) preserves edge color for downstream compositing where a matte will be re-applied.
46. AE no longer ships H.264 in its native render queue for most flows; for H.264/HEVC delivery, use Cmd+Alt+M to send to Adobe Media Encoder, where queueing, watch folders, and hardware acceleration live.

### Workspace
47. Default workspaces (Standard, Animation, Effects, Motion Tracking, Paint, Text, Essential Graphics, Libraries, Learn) are accessed via Window → Workspaces or the workspace dropdown top-right and can each be customized then saved.
48. The Region of Interest button at the bottom of the Composition viewer renders only a dragged sub-rectangle for fast previews of expensive areas, without changing the comp's actual output.

### Hidden Utilities
49. `Animation → Keyframe Assistant → Convert Audio to Keyframes` (or Cmd+Alt+/) bakes an audio layer's amplitude into a null with slider keyframes per frame, which expressions can read with `thisComp.layer("Audio Amplitude").effect("Both Channels")("Slider")` to drive any property from music.
50. File → Increment and Save (Cmd+Alt+Shift+S) is the canonical AE versioning move — it saves _v002.aep next to your current file and switches you to the new one in one keystroke.
51. File → Dependencies → Reduce Project purges every footage / comp / asset not feeding the currently selected items, and is the standard archive prep before delivery.
52. Edit → Purge → All Memory & Disk Cache is the first move when AE is sluggish, behaving strangely, or showing stale previews — it forces a full re-render on next playback.
