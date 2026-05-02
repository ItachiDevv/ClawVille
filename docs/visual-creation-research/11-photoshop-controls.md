# Adobe Photoshop — Durable Working-Artist Reference (Round 2)

> Anchor knowledge complement to `07-photoshop-2026.md`. Recency-agnostic. The parts of Photoshop that have been true for 5+ years.

This doc holds the 50 knowledge[]-ready facts from round 2 of the deep-controls research — written for direct paste into `packages/agent-templates/src/locations/canvas-studio.ts`. The full reference body (keyboard maps, every tool group, every blend mode, every adjustment, every filter category, layer styles, masking, text, color management, 30 task recipes, Pen tool, Smart Objects, Camera Raw, web/UI, history, workspace) is documented in the agent task transcript at the corresponding research run.

## knowledge[]-ready facts (50)

### Shortcuts
1. Holding Spacebar in Photoshop temporarily activates the Hand tool from any other tool, making it the universal "pan" shortcut.
2. `Cmd/Ctrl+J` duplicates a layer or, if pixels are selected, jumps the selection onto a new layer.
3. `Cmd/Ctrl+Alt+Shift+E` stamps all visible layers into a single new layer above without merging the originals.
4. `Cmd/Ctrl+Shift+I` inverts a selection, while `Cmd/Ctrl+I` inverts pixel values — different operations sharing a similar shortcut.
5. The bracket keys `[` and `]` resize the active brush, and adding Shift adjusts brush hardness instead.

### Tools
6. The Object Selection tool (W) draws a box and AI-detects the subject inside, replacing manual lasso work for most cutouts.
7. The Patch tool drags a freeform selection to a clean source area and blends texture and color automatically.
8. The Mixer Brush simulates wet-paint mixing with bristle and load controls and is the closest thing Photoshop has to traditional painting.
9. Curvature Pen lets users click points and Photoshop infers smooth curves between them, removing the Bezier-handle learning curve.
10. The Frame tool (K) creates rectangular or elliptical placeholders that auto-mask any image dragged into them.

### Blend modes
11. Multiply darkens by multiplying channel values; pure white becomes invisible, making it ideal for stamping ink or dark line art on white.
12. Screen is Multiply's inverse and is the canonical way to composite fire, flares, sparks, or fog shot on a black background.
13. Overlay is Multiply on darks and Screen on lights, making a 50%-gray Overlay layer the standard non-destructive dodge & burn surface.
14. Difference subtracts blend from base in absolute value and produces pure black where two layers match, useful for aligning duplicates.
15. Color blend mode applies the blend layer's hue and saturation while preserving the base's luminosity, which is how black-and-white photos get colorized.
16. Luminosity blend mode applies the blend layer's brightness without shifting hue or saturation, which is how Curves contrast is added without color shift.

### Adjustments
17. Curves is the all-purpose tone-and-color tool: an S-curve adds contrast, per-channel curves color grade, and the on-canvas scrubber targets specific tones.
18. Vibrance boosts low-saturation colors more aggressively than already-saturated ones and protects skin tones, making it safer than raw Saturation.
19. Gradient Map adjustments map luminance to a gradient and are the quickest way to build duotones or apply a film color grade non-destructively.
20. Selective Color performs per-color CMYK adjustments and is the standard tool for print-prep tweaks like cooling shadows or warming highlights.

### Filters
21. Camera Raw Filter exposes the full Lightroom-style editor on any layer, including AI Subject/Sky masking, lens corrections, and creative profiles.
22. Liquify's Face-Aware mode auto-detects faces and exposes per-feature sliders for eyes, nose, mouth, and jaw without manual mesh painting.
23. High Pass filter combined with Overlay or Soft Light blend mode is the canonical edge-sharpening and frequency-separation skin-retouch technique.
24. Smart Sharpen (preferred over Unsharp Mask) supports separate shadow/highlight fade controls and a noise-reduction slider in one dialog.
25. Stack Modes (Layer > Smart Objects > Stack Mode) statistically combine aligned layers — Median removes tourists from a busy plaza given multiple frames.

### Layer Styles
26. Layer Styles render top-to-bottom: Drop Shadow at the bottom, then Outer Glow, Pattern/Gradient/Color Overlay, Satin, Inner Glow, Inner Shadow, Stroke, Bevel & Emboss.
27. Global Light synchronizes the angle of every layer effect that has an angle parameter across the entire document so lighting stays consistent.
28. Converting a styled layer to a Smart Object bakes its effects so they don't re-render at new sizes — required when scaling logo lockups precisely.

### Selections + Masking
29. Select & Mask replaced Refine Edge and outputs to Selection, Layer Mask, New Layer, or New Layer with Mask, with Decontaminate Colors removing edge color fringe.
30. Color Range selects by sampled color with a Fuzziness slider and includes a Skin Tones preset with optional Detect Faces for portrait masking.
31. Quick Mask mode (Q) lets you paint your selection: black subtracts, white adds, and gray gives partial selection that becomes feathered alpha when exiting.

### Text
32. Type on a Path is created by drawing any vector path and clicking on it with the Type tool, then dragged along the path with the Direct Selection tool.
33. Warp Text exposes 16 named distortions (Arc, Bulge, Flag, Wave, Fish, Rise, Squeeze, etc.) plus Bend and Distortion sliders, while preserving live editable text.
34. Variable Fonts in Photoshop expose continuous sliders for weight, width, slant, and optical size when the active font supports them.

### Color Management
35. Convert to Profile changes pixel values to preserve appearance in a new color space; Assign Profile reinterprets existing values and changes appearance — Convert is almost always the right choice.
36. Working in 16-bit/channel prevents banding during heavy tonal edits and is required when editing in ProPhoto RGB to avoid 8-bit posterization.
37. Soft Proof (View > Proof Setup) previews the document in another profile such as a printer's CMYK profile, while Gamut Warning highlights out-of-gamut regions.

### Recipes
38. The non-destructive dodge & burn workflow is a new layer filled with 50% gray, set to Soft Light blend mode, painted with low-opacity white and black brushes.
39. Frequency separation splits a portrait into a low-frequency color layer (Gaussian-blurred) and a high-frequency texture layer (Apply Image), letting tones and pores be retouched independently.
40. Generative Expand is invoked by selecting the Crop tool, dragging past the canvas edge, leaving the prompt empty, and clicking Generate in the Contextual Task Bar.
41. A drop shadow that doesn't look terrible uses Multiply blend mode with a desaturated dark color sampled from the scene, distance ~ object height × 0.1, and 30–50% opacity.
42. Sky Replacement (Edit > Sky Replacement) provides preset skies and exposes Foreground Adjustments to relight the rest of the image to match the new sky's color and brightness.

### Pen + Paths
43. Cmd/Ctrl+Enter converts an active path to a selection without opening the Make Selection dialog — the fastest path-to-selection shortcut.
44. Right-clicking a path and choosing Stroke Path with the Brush option (with Simulate Pressure on) produces tapered, hand-drawn-looking lines along precise vector geometry.
45. Path Operations (Combine, Subtract, Intersect, Exclude) perform boolean operations on vector shapes and are how multi-shape vector logos get built non-destructively.

### Smart Objects
46. Smart Objects make filters non-destructive — every applied filter becomes a re-editable Smart Filter with its own mask and blending options.
47. Replace Contents on a Smart Object swaps the source while preserving all transforms, filters, masks, and layer styles — the foundation of every PSD mockup template.
48. Linked Smart Objects reference an external file rather than embedding it, letting a single shared logo update across many PSDs at once.

### Camera Raw / History / Workspace
49. Camera Raw masking supports Add, Subtract, and Intersect operations between AI masks (Subject, Sky, Object), brush strokes, gradients, and Range Masks (Color, Luminance, Depth) for precise local adjustments.
50. The History panel defaults to 50 states (raise in Preferences > Performance up to 1000), and clicking the camera icon saves an in-session Snapshot that won't get purged by new edits.
