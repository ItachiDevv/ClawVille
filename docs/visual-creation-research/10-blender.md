# Blender — Anchor Reference for the Pineapple House (Visual Creation)

> Audience: AI agents and developers using Blender end-to-end. Anchor knowledge — the parts of Blender that have been the same since 2.8 and remain true through the 4.x line (LTS 4.2 is the conservative target). Different audience from the internal `blender07` automation skill: this is the in-game NPC's RAG corpus, written for someone deciding what to do, not someone scripting MCP tool calls.
>
> Manual base URL throughout: <https://docs.blender.org/manual/en/latest/>

---

## 1. The Canonical Keyboard Shortcut Map

Blender is a modal, keyboard-first program. Refusing to learn the shortcuts is the single largest cause of "Blender is hard". The shortcut map below is the durable set — it has worked the same way since Blender 2.8.

### Transform tools — the foundation

- **G** — Grab (translate). Drag, click to confirm, right-click to cancel.
- **R** — Rotate. Press R again for trackball rotate.
- **S** — Scale. Drag outward to grow, inward to shrink.
- **Axis suffixes**: after pressing G/R/S, hit **X**, **Y**, or **Z** to lock the operation to that axis. Example: `G X 5 Enter` translates 5 Blender units along world X.
- **Hold Shift on the axis** to *exclude* that axis. `G Shift+Z` moves in the XY plane.
- **Local axes**: press the axis key twice. `G X X` translates along the object's local X.
- **Numeric input**: type a number while transforming. `S 2 Enter` scales to 2×.
- **Alt+G / Alt+R / Alt+S** — Clear translation/rotation/scale.
- **GG** — Edge slide (in Edit Mode, with edges selected).
- **Shift+R** — Repeat last operation.
- **Ctrl+A** — Apply menu (Location, Rotation, Scale, All Transforms, Visual Transform).
- **Ctrl+P / Alt+P** — Parent / Clear Parent.

### Selection

- **A** — Select all. **Alt+A** — Deselect all (also `A A` quickly).
- **B** — Box select. Drag a rectangle.
- **C** — Circle select. Scroll to resize, click-drag to paint, Esc/Enter to finish.
- **L** — Select linked under the cursor (great for picking out a single mesh island).
- **Ctrl+L** — Select linked from active (extends across selection).
- **Shift+L** — Select linked all (everything connected).
- **Ctrl+Numpad+/Ctrl+Numpad-** — Grow/shrink selection by one ring.
- **Ctrl+I** — Invert selection.
- **Alt+click** an edge loop, **Alt+Shift+click** to add another loop.

### Mode switching

- **Tab** — Toggle Edit/Object Mode.
- **Ctrl+Tab** — Pie menu for mode switching (Sculpt, Vertex Paint, Weight Paint, Texture Paint, Pose, etc., depending on object type).
- In Edit Mode for meshes: **1 = vertex**, **2 = edge**, **3 = face** select mode.

### Edit-Mode mesh tools

- **E** — Extrude.
- **I** — Inset face.
- **F** — Make face/edge from selection.
- **K** — Knife. Click to add cuts, Enter to commit.
- **J** — Connect vertices (path).
- **Ctrl+B** — Bevel. Scroll to add segments.
- **Ctrl+R** — Loop cut. Scroll to add multiple loops, click to confirm position, right-click to drop at center.
- **Ctrl+E / Ctrl+V / Ctrl+F** — Edge / Vertex / Face context menus.
- **M** — Merge menu (At Center, At Cursor, By Distance, At First, At Last).
- **Alt+M** — Same merge menu (legacy alias).
- **P** — Separate (by selection / by material / by loose parts).
- **Ctrl+J** — Join selected objects into the active.
- **Y** — Rip (split connected geometry while keeping the topology).

### Viewport navigation (numpad-centric)

- **Middle-mouse-drag** — Orbit.
- **Shift+MMB** — Pan.
- **Scroll** — Zoom (or **Ctrl+MMB**-drag for smoother zoom).
- **Numpad .** — Frame selected.
- **Numpad /** — Local view (isolate selected).
- **Numpad 1 / 3 / 7** — Front / Right / Top orthographic. Add **Ctrl** for the opposite side (Numpad Ctrl+1 = back).
- **Numpad 0** — Camera view.
- **Numpad 5** — Toggle perspective/orthographic.
- **` (backtick)** — Viewport pie menu (axis views).
- **Numpad 4/6/8/2** — Rotate view in 15° steps.

Manual: <https://docs.blender.org/manual/en/latest/editors/3dview/navigate/index.html>

### Snapping, undo, search

- **Shift+Tab** — Toggle snap.
- **Ctrl+Z / Ctrl+Shift+Z** — Undo / Redo.
- **F3** — Universal command search ("what was that operator called?").
- **Q** — Quick Favorites (pin operators with right-click → Add to Quick Favorites).

### Render & files

- **F12** — Render still.
- **Ctrl+F12** — Render animation.
- **F11** — Toggle render result window.
- **Ctrl+S** / **Ctrl+Shift+S** — Save / Save As.
- **Ctrl+1 / Ctrl+2 / Ctrl+3** — Subdivision Surface levels 1/2/3 on the active object (handy modeling shortcut, distinct from the incremental save preference).
- **Ctrl+O** — Open.

### Outliner & animation

- **H / Alt+H / Shift+H** — Hide / Unhide / Hide unselected (isolate).
- **I** — Insert Keyframe (menu — pick what to key).
- **Alt+I** — Clear Keyframe.
- **Spacebar** — Play animation (default in 4.x with the "Animation" preset).

Manual reference: <https://docs.blender.org/manual/en/latest/interface/keymap/blender_default.html>

---

## 2. Every Editor Type and What It's For

Blender is a window-manager of editors, not a single 3D viewport. The editor type is set per-area via the icon at the top-left of each pane. Knowing which editor solves which problem is half the battle.

- **3D Viewport** — The world. Modeling, posing, sculpting, viewport rendering.
- **Outliner** — Scene tree. Toggle visibility, lock selection, mark assets, drag-parent.
- **Properties** — The right tabbed panel with everything else: Render, Output, View Layer, Scene, World, Object, Modifiers (wrench), Particles, Physics, Object Constraints, Object Data (green icon — varies by object type), Material, Texture (legacy).
- **Timeline** — Frame range, playback controls, simple keyframe markers.
- **Dope Sheet** — Per-keyframe timing. Shift keys, scale time, channel-by-channel grouping. Has filter modes for Action Editor, Shape Key Editor, Grease Pencil, Mask, Cache File.
- **Graph Editor** — F-curves and interpolation handles. The single most important editor for animators.
- **NLA Editor** — Non-Linear Animation. Push actions down to strips, blend, scale, layer.
- **Shader Editor** — Node-based materials. Switch the dropdown to World to edit the environment shader instead of the active object's material.
- **Geometry Nodes Editor** — Procedural geometry. Lives as a Modifier; opens here for the node graph.
- **Compositor** — Post-processing on the rendered image. Glare, Lens Distortion, color grading, multi-layer comp.
- **Texture Node Editor** — Legacy texture node trees (rare in modern workflows; Cycles/EEVEE use the Shader Editor).
- **UV Editor** — Unwrap, edit UVs, paint into the texture.
- **Image Editor** — Texture painting on flat images, image viewing, color picking.
- **Movie Clip Editor** — Motion tracking and masking footage.
- **Video Sequence Editor (VSE)** — A real video editor inside Blender. Cuts, transitions, audio mixing, color strips, adjustment layers.
- **Text Editor** — Write and run Python scripts (Alt+P to execute the current text-block).
- **Python Console** — Interactive `bpy` REPL with auto-complete (Ctrl+Space).
- **Info** — Log of every action you take, formatted as Python you can copy.
- **File Browser** — Built-in file picker. Detachable as a window.
- **Asset Browser** — Drag-drop assets from libraries marked in Preferences.
- **Spreadsheet** — Inspect geometry attributes — verts, faces, fields. Indispensable for Geometry Nodes debugging.
- **Preferences** — Edit > Preferences. Themes, add-ons, keymap, file paths.

Manual index: <https://docs.blender.org/manual/en/latest/editors/index.html>

---

## 3. Object Modes

Different object types unlock different modes. The mode dropdown is at the top-left of the 3D Viewport.

- **Object Mode** — Move, rotate, scale, parent, link, duplicate. The default.
- **Edit Mode** — Vertex/edge/face editing. Available on meshes, curves, surfaces, metaballs, text, lattices, armatures, grease pencil. Tab toggles in/out.
- **Sculpt Mode** — Brush-based mesh deformation. Multires, Dyntopo, or Voxel Remesh as the topology back-end.
- **Vertex Paint** — Per-vertex color attributes (used as inputs to shaders or for AO baking).
- **Weight Paint** — Vertex group weights, primarily for armature deformation. Brushes apply weights from 0 to 1.
- **Texture Paint** — Paint directly onto image textures via 3D viewport projection.
- **Pose Mode** — Armatures only. Move bones, set keyframes, run constraints.
- **Edit Mode (curves/surfaces/metaballs/text/grease pencil)** — Each has its own tools. Curve Edit Mode handles Bézier/NURBS handles; Text Edit Mode is a real text caret; Grease Pencil Edit Mode treats strokes as curve-like primitives.

Manual: <https://docs.blender.org/manual/en/latest/editors/3dview/modes.html>

---

## 4. The Modifier Stack — Categorized

Modifiers are non-destructive operations evaluated top-down. The stack is per-object, lives in the Properties → Modifier tab (wrench icon). Stack order matters — Mirror **before** Subdivision Surface, otherwise the seam doesn't merge.

### Modify

- **Data Transfer** — Copy normals/UVs/weights from one mesh to another.
- **Mesh Cache** / **Mesh Sequence Cache** — Replay baked deformation from PC2/MDD or Alembic.
- **Normal Edit** — Override smooth-shading normals.
- **Weighted Normal** — Weight face normals by area/angle for cleaner shading on bevels.
- **UV Project** — Project UVs from a controlling object (faux-decals).
- **UV Warp** — Distort existing UVs by an object's transform.
- **Vertex Weight Edit / Mix / Proximity** — Procedurally edit weight maps (used as masks for other modifiers).

### Generate

- **Array** — Duplicate along an offset/curve/object.
- **Bevel** — Bevel edges (also a destructive Edit Mode tool).
- **Boolean** — Union/Difference/Intersect another mesh. Pair with Bool Tool add-on.
- **Build** — Animate verts appearing in order.
- **Decimate** — Reduce poly count (Collapse / Un-Subdivide / Planar).
- **Edge Split** — Split edges by angle for hard-edge shading. Largely superseded by Auto Smooth.
- **Geometry Nodes** — Procedural geometry. The flagship modifier.
- **Mask** — Hide verts by group/object.
- **Mirror** — Mirror across local axes; auto-merge centerline.
- **Multiresolution (Multires)** — Subdivide for sculpting at multiple levels; bake details to normal maps.
- **Remesh** — Voxel/Smooth/Sharp remeshing for clean topology.
- **Screw** — Lathe/spiral.
- **Skin** — Build geometry around a vertex skeleton (great for quick characters).
- **Solidify** — Give a flat surface thickness.
- **Subdivision Surface** — Catmull-Clark smoothing (the workhorse).
- **Triangulate** — Convert quads/n-gons to tris (often required for game export).
- **Volume to Mesh** — Convert OpenVDB volume to mesh.
- **Weld** — Merge verts within a distance threshold.
- **Wireframe** — Convert each edge to a tube.

### Deform

- **Armature** — Skeletal deformation. The bone modifier.
- **Cast** — Push verts toward sphere/cylinder/cuboid shape.
- **Curve** — Bend along a curve.
- **Displace** — Push verts by a texture or strength.
- **Hook** — Attach verts to an object/bone.
- **Laplacian Deform** — Preserve local detail under deformation.
- **Lattice** — Deform with a lattice cage.
- **Mesh Deform** — Drive a high-poly with a low-poly cage.
- **Shrinkwrap** — Stick verts to another surface (retopo helper).
- **Simple Deform** — Twist/Bend/Taper/Stretch.
- **Smooth / Smooth Corrective / Smooth Laplacian** — Smooth verts (Corrective preserves bind-pose intent).
- **Surface Deform** — Bind one mesh to another's surface deformation.
- **Warp / Wave** — Procedural deformation around an axis or in a wave.
- **Volume Displace** — Displace OpenVDB volumes.

### Physics

- **Cloth** — Cloth simulation; pair with Collision on the table.
- **Collision** — Mark an object as a collider for cloth/particles/soft body.
- **Dynamic Paint** — Bake brush strokes from object interaction.
- **Explode** — Pair with a particle system to scatter mesh fragments.
- **Fluid** — Liquid/gas simulation (Mantaflow). Domain/Flow/Effector roles.
- **Ocean** — Procedural ocean surface with foam.
- **Particle Instance** — Use particles to instance other objects.
- **Particle System** — Hair or Emitter; the underlying simulation modifier.
- **Soft Body** — Squishy physics for non-cloth deformation.

Manual: <https://docs.blender.org/manual/en/latest/modeling/modifiers/index.html>

---

## 5. Geometry Nodes Essentials

Geometry Nodes is Blender's node-based procedural geometry system. It lives as a modifier; you add a Geometry Nodes modifier and edit the tree in the Geometry Nodes Editor.

**Mental model.** Geometry flows left to right through the graph. Each node receives geometry, transforms it, and passes it on. The default `Group Input → Group Output` passes the modifier's input geometry through unchanged.

**Socket colors.**

- **Green** — Geometry (mesh, curve, point cloud, instances, volume).
- **Purple** — Field (per-element values evaluated in context, e.g. Position evaluated per vertex).
- **Gray** — Single value (one float, one vector, one boolean).
- **Fuchsia / pink** — String.
- **Light blue / orange** — Object, Material, Collection references.

**Fields vs values.** A Field is a function evaluated per element by the consumer (Set Position evaluates Position per vertex). A single value is computed once. Sample Index "freezes" a Field into per-element data on a different domain.

**Common node families.**

- **Input** — Group Input, Position, Normal, Index, ID, Radius, Named Attribute.
- **Mesh Primitives** — Cube, Cylinder, UV Sphere, Ico Sphere, Cone, Grid, Line.
- **Mesh Operations** — Set Position, Extrude Mesh, Subdivide, Triangulate, Dual Mesh, Split Edges, Merge by Distance.
- **Curve Primitives + Operations** — Bezier Segment, Curve Circle, Resample Curve, Curve to Mesh.
- **Instances** — Instance on Points, Realize Instances, Translate Instances, Rotate Instances, Scale Instances.
- **Utilities** — Math, Vector Math, Compare, Boolean Math, Switch, Mix, Map Range, Float Curve, Random Value.
- **Sampling** — Sample Index, Sample Nearest, Sample Nearest Surface, Raycast, Proximity.

**Realize Instances gotcha.** Instances are lightweight placeholders; downstream nodes that expect real verts (Set Position by index, geometry math on the instanced mesh) won't see them until you realize. Realize Instances is expensive — only use when you must.

Manual: <https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/index.html>

---

## 6. Shader Editor and Render Engines

**Engines.**

- **Cycles** — Path-traced reference renderer. Physically accurate. GPU via OptiX (NVIDIA), CUDA (older NVIDIA), HIP (AMD), Metal (Apple Silicon), OneAPI (Intel Arc/iGPU). Sample-based with adaptive sampling and OptiX/OpenImageDenoise.
- **EEVEE Next** — Real-time PBR rasterizer with screen-space reflections, screen-space global illumination, and (in 4.2+) raytraced shadows. Uses light probes (Reflection Plane, Reflection Cubemap, Irradiance Volume) for indirect lighting; legacy EEVEE files require a probe re-bake after upgrading.
- **Workbench** — Solid/MatCap/Random preview. Used for fast renders that don't care about lighting realism (turntables, viewport preview).

**Principled BSDF — the workhorse shader.** A single uber-shader that approximates almost any opaque or thin-film material. Inputs every artist memorizes: Base Color, Metallic, Roughness, IOR, Specular (called Specular IOR Level in 4.x), Normal, Coat, Sheen, Emission, Alpha. 99% of modern PBR materials are a Principled BSDF with a few image textures wired in.

**Other useful shaders.** Glass BSDF, Diffuse BSDF, Glossy BSDF, Transparent, Mix Shader, Add Shader, Emission, Hair BSDF, Volume Scatter, Volume Absorption, Background.

**Common helper nodes.** Image Texture, Color Ramp, Math, Mix (Color/Vector/Float), Bump, Normal Map, Mapping + Texture Coordinate (the standard pair to control UV transformations).

**World shader.** Switch the Shader Editor's data dropdown from Object to World. Standard HDRI setup: Texture Coordinate (Generated) → Mapping → Environment Texture → Background → World Output.

**Render samples and denoising.** Cycles uses Sample counts (default 1024 final, 32 viewport). Adaptive Sampling shortcuts when noise is below threshold. Denoise via OptiX (NVIDIA only) or OpenImageDenoise (CPU/cross-platform). Always denoise final renders unless you specifically want film grain.

Manual: <https://docs.blender.org/manual/en/latest/render/index.html>

---

## 7. Animation System

**Keyframes.** Press **I** in the 3D Viewport, pick what to key (Location, Rotation, Scale, LocRot, Available, etc.). Auto Keyframe (the red dot in the timeline) keys automatically as you transform.

**F-Curve interpolation modes.** Constant, Linear, Bezier (default, with editable handles), Sinusoidal, Quadratic, Cubic, Quartic, Quintic, Exponential, Circular, Bounce, Elastic, Back. Set in the Graph Editor with **T**.

**F-Curve modifiers.** Generator (polynomial), Cycles (loop), Noise (procedural jitter), Limits, Stepped Interpolation, Built-in Function. Stack on a curve to procedurally extend or constrain its motion.

**Drivers.** Right-click any property → Add Driver. Drives the property by an expression evaluating other properties. Edit in the Graph Editor's Drivers mode. Common: drive bone scale by another bone's position, drive shape key by a control bone's rotation. Driver expressions are real Python — `var * 2` works; `var.x` for vector components.

**Constraints.** Object Constraints (Properties tab) and Bone Constraints (Bone Properties tab). The classic eleven: Copy Location, Copy Rotation, Copy Scale, Track To, Damped Track, Locked Track, Inverse Kinematics (IK), Stretch To, Floor, Limit Distance, Child Of, Action constraint. Constraints evaluate top-down; constraint stack order matters.

**NLA workflow.** Create an Action in the Action Editor or Dope Sheet → "Push Down" to NLA → becomes an NLA Strip → blend strips with influence + extrapolation + blend mode (Replace/Add/Subtract/Combine) → layer strips for additive idle-on-walk overlays.

**Markers.** Pose markers in the Action Editor pin a frame to a name (used by the Pose Library and Action constraint). Timeline markers organize the timeline.

Manual: <https://docs.blender.org/manual/en/latest/animation/index.html>

---

## 8. Rigging

**Armature object.** Add → Armature creates a single bone. In Edit Mode, **E** extrudes a new bone parented to the previous; this is how chains are built.

**Three views of a bone.** Edit Bone (rest pose, set in Edit Mode), Pose Bone (current animation pose, manipulated in Pose Mode), Bone (the underlying data — names, layers/collections, custom properties).

**Bone constraints.** IK is the marquee constraint — chain length defines how many bones in the chain solve, pole target controls the elbow/knee direction. Stretch To, Limit Rotation, and Copy Rotation handle most secondary rigging.

**Inverse Kinematics.** Add IK constraint to the last bone in a chain (the wrist). Set Chain Length (e.g. 2 = arm + forearm). Add a pole target (an Empty placed beside the elbow) to control the elbow plane. Auto-IK in Pose Mode (header toggle) does temporary IK during posing without a constraint.

**Weight Paint mode.** Paint vertex group weights from 0 to 1. Brushes: Add (paints weight), Subtract, Mix, Blur, Average, Smear. Mirror via the X-Mirror toggle in the header.

**Skinning methods.** Automatic Weights (Ctrl+P → Armature with Automatic Weights — bone heat algorithm), Envelope (bone-shape volume, faster but cruder), or fully manual via Weight Paint and Vertex Groups.

**Bone Collections (4.x).** What used to be "Bone Layers" is now Bone Collections — named, hierarchical groups for show/hide. Old layer-based rigs upgrade automatically.

**Custom display objects.** Set a bone's Custom Object in Bone Properties → Viewport Display to make it draw as another mesh (a circle, a hand-shape) instead of the default octahedral bone. Standard for rig controls.

**Rigify.** Built-in auto-rig add-on. Add a Metarig → place to fit the character → Generate. Produces a deformation rig + control rig with FK/IK switching, finger curls, facial controls.

**Mixamo bone naming.** Mixamo rigs prefix every bone with `mixamorig:` (e.g. `mixamorig:Hips`, `mixamorig:LeftArm`). Don't strip the prefix unless your downstream tooling demands it — many retarget add-ons key off it.

Manual: <https://docs.blender.org/manual/en/latest/animation/armatures/index.html>

---

## 9. Sculpting

**Topology back-ends.**

- **Multiresolution (Multires)** — Subdivide a base mesh several times; sculpt at any level; bake details down to a normal map. Best for keeping clean retopology beneath the detail.
- **Dyntopo** — Dynamic topology. Adds/removes triangles as you sculpt. Toggle with Ctrl+D. Set Detail Size; Refine Method = Subdivide Edges / Collapse Edges / Subdivide Collapse.
- **Voxel Remesh** — Remesh the entire object to a uniform voxel grid (Ctrl+R in Sculpt Mode, or use the Remesh modifier). Good for blocking out forms.

**Common brushes.** Draw, Clay Strips, Clay, Crease, Smooth (Shift held with any brush), Inflate, Grab, Pinch/Magnify, Snake Hook, Mask, Pose, Cloth, Boundary, Slide Relax, Multi-plane Scrape, Scrape, Flatten, Fill.

**Masks and Face Sets.** Mask brush (M to swap to it) paints a per-vertex mask 0–1 that protects geometry from other brushes. Face Sets (Ctrl+W to assign, W to expand) group polygons for the Pose, Boundary, and Edit-Face-Set workflows.

**Pose Brush.** Treats a chain of polygons as an IK rig and lets you bend the mesh. Set "IK Segments" to control the chain length.

**Symmetry.** X / Y / Z toggles in the Symmetry panel for axis mirroring. Tiling for repeating-pattern sculpts. Radial symmetry for things like flowers or gears.

Manual: <https://docs.blender.org/manual/en/latest/sculpt_paint/sculpting/index.html>

---

## 10. UV Unwrapping

**Mark Seam.** Select edges, Ctrl+E → Mark Seam. Seams are where the unwrap will cut.

**Unwrap operators (U menu).** Unwrap (uses seams), Smart UV Project (auto-cuts by angle threshold), Cube/Cylinder/Sphere Project (planar projections), Lightmap Pack (for second UV channel lightmaps), Unwrap (Conformal vs Angle Based — Angle Based is the modern default).

**UV Editor tools.** Pin (P) / Unpin (Alt+P) holds verts in place during Live Unwrap. Pack Islands packs UV islands into the 0–1 square. Average Islands Scale normalizes texel density. Minimize Stretch (Ctrl+V) iteratively reduces distortion.

**Standard character workflow.** Mark seams along symmetry, hairline, ear roots, and any natural hidden edge → Unwrap → Average Islands Scale → Pack Islands.

Manual: <https://docs.blender.org/manual/en/latest/modeling/meshes/uv/index.html>

---

## 11. Python API Basics (`bpy`)

Three top-level handles to know:

- **`bpy.ops`** — Operators. Anything the GUI does. `bpy.ops.mesh.primitive_cube_add()`. Operators need correct context (right area, right mode), so they can be flaky in headless scripts.
- **`bpy.data`** — The project's data. `bpy.data.objects['Cube']`, `bpy.data.materials['Mat']`. Reliable in any context — prefer for headless work.
- **`bpy.context`** — Current state. `bpy.context.active_object`, `bpy.context.selected_objects`, `bpy.context.scene`.

Rule of thumb: use `bpy.data` for "what exists" and to mutate object data structures; use `bpy.ops` only when you must (operators that have no equivalent direct API).

**Headless rendering.**

```bash
blender -b file.blend -o //out_ -F PNG -f 1     # render frame 1
blender -b file.blend -o //out_ -F PNG -a       # render full animation
blender -b file.blend -P script.py              # run a Python script
blender -b file.blend --python-expr "import bpy; print(len(bpy.data.objects))"
```

`-b` = background (no GUI). `-o` = output prefix (`//` is the .blend's directory). `-F` = format. `-f N` = single frame. `-a` = animation.

**Add-on structure.** A `__init__.py` with a `bl_info` dict and `register()` / `unregister()` functions. Drop the file (or a folder containing `__init__.py`) into Blender's add-ons path and enable in Preferences → Add-ons.

**The Info editor trick.** Switch any pane to Info editor type → take an action in the GUI → Info logs the equivalent Python call. Right-click → Copy → paste into the Text Editor. This is the fastest path from "I clicked it" to "I have a script that does it".

Manual: <https://docs.blender.org/api/current/index.html>

---

## 12. Render Engines and Render Settings

**Cycles in detail.**

- Path traced. Set Samples (1024 final / 32 viewport is a sane default). Adaptive Sampling shortcuts converged pixels.
- Devices: OptiX (NVIDIA RTX, fastest, with hardware ray tracing), CUDA (older NVIDIA), HIP (AMD), Metal (Apple Silicon), OneAPI (Intel Arc/Iris Xe). Configure in Preferences → System → Cycles Render Devices.
- Light Paths panel: Max Bounces (Total/Diffuse/Glossy/Transmission/Volume) and Clamp Direct/Indirect (clamp fireflies).
- Tile Size: was a big lever in 2.8x; in 4.x, leave at default unless rendering very large frames on low-VRAM GPUs.
- Denoising: OptiX denoiser (NVIDIA, fast, viewport+final) or OpenImageDenoise (CPU, cross-platform, slower but more stable for animation).

**EEVEE Next.** Real-time PBR. Screen Space Reflections, Screen Space Global Illumination, raytraced shadows (4.2+), Bloom, Depth of Field, Motion Blur. Light probes (Reflection Plane, Reflection Cubemap, Irradiance Volume) capture indirect lighting; bake via the Light Probes panel.

**Workbench.** Solid / MatCap / Random shading modes for fast preview renders.

**Output settings.** Resolution (X/Y, %), Frame Range (Start/End/Step), Output path (`//render/####.png` — `####` becomes the zero-padded frame number), File Format (PNG, JPEG, OpenEXR, FFmpeg video).

**Color Management.** View Transform: Standard (raw sRGB), Filmic (cinematic, the default for years), AgX (the modern, more neutral option in 4.x). Look: None / High Contrast / Medium Contrast / Low Contrast / Very High Contrast. Always pick a perceptual View Transform — Standard alone clips highlights ungracefully.

Manual: <https://docs.blender.org/manual/en/latest/render/output/index.html>

---

## 13. Compositor and VSE

**Compositor.** Enable in Properties → Render → Use Nodes (or open the Compositor and check Use Nodes). The standard tree: Render Layers → (filters) → Composite. Common nodes:

- **Glare** — Bloom, fog glow, streaks.
- **Lens Distortion** — Barrel/pincushion, chromatic aberration.
- **Defocus / Vector Blur** — Depth-of-field and motion blur in post.
- **Color Correction / Color Balance / Curves / Hue Saturation Value** — Color grading.
- **Mix / Alpha Over** — Composite multiple layers.
- **Set Alpha** — Replace alpha channel.
- **Cryptomatte** — Per-object/material mask passes for selective grading.
- **Denoise** — Post-render denoise (alternative to render-time denoise).
- **Z Combine** — Composite by depth.

**Video Sequence Editor (VSE).** Add Strip → Movie / Image Sequence / Sound / Color / Adjustment Layer / Effect Strip. Strip menu has Speed Control, transitions (Cross, Wipe, Gamma Cross), Adjustment Layer (apply effects to underneath strips). Audio mixing with per-strip volume + pan envelopes. Render through Properties → Output → File Format = FFmpeg Video.

Manual: <https://docs.blender.org/manual/en/latest/compositing/index.html> · VSE: <https://docs.blender.org/manual/en/latest/video_editing/index.html>

---

## 14. Asset Browser and Asset Library

**Mark as Asset.** Right-click in Outliner or Asset Browser → Mark as Asset. Works on Objects, Materials, Worlds, Actions, Node Groups, Brushes, Poses.

**Asset Library paths.** Preferences → File Paths → Asset Libraries. Add a folder; every `.blend` inside is scanned for assets.

**Drag-drop.** Drag from the Asset Browser into the 3D Viewport. Hold the appropriate modifier or use the dropdown to choose Append (full copy) vs Link (reference original) vs Append (Reuse Data).

**Metadata.** Catalog (folder), Tags, Description, Author, Copyright, License — searchable in the Asset Browser filter.

**Pose Library.** The pose-management workflow is now Asset-Browser-based. Mark a pose as an asset → drag from the Asset Browser onto a character to apply.

Manual: <https://docs.blender.org/manual/en/latest/files/asset_libraries/index.html>

---

## 15. The 30 Most-Common Tasks

1. **Hard-surface model with bevels** — Block out with primitives → extrude/inset → Bevel modifier (Limit Method = Angle, Width type = Width) → Subdivision Surface.
2. **Retopo a sculpt** — Add Multires *before* sculpting if you can. Otherwise: Shrinkwrap modifier on a low-poly retopo mesh, snap-to-face-project enabled, manually quad-draw with Poly Build tool.
3. **Unwrap a character** — Mark seams along symmetry + back-of-ear + hairline + armpit + crotch (hidden edges) → Unwrap → Average Islands Scale → Pack Islands.
4. **Bake textures** — Cycles → Render Properties → Bake. Add an Image Texture node to the material, leave it *selected but unconnected*. Pick Bake Type (Diffuse, Normal, AO, Combined). For normal bakes, set Selected to Active and bake from high-poly to low-poly.
5. **Texture paint a model** — Texture Paint Mode → add an Image Texture in the material → paint with brushes. Use Stencil mode to paint from a reference image projected from the camera.
6. **Animate a bouncing ball** — 3 keyframes (top, contact-squashed, top). Open the Graph Editor, set the contact frame's interpolation to Bezier with steeper handles for the snap.
7. **Rig a humanoid** — Add → Armature → Rigify Metarig → fit to character → Generate. Parent mesh to generated rig with Automatic Weights (Ctrl+P).
8. **Parent objects** — Select children, Shift-select parent (active), Ctrl+P → Object/Bone/Vertex/Lattice. Alt+P clears.
9. **Constrain camera to follow a path** — Add a curve, add a Follow Path constraint to the camera, point to the curve, Animate Path button. Or parent camera to an Empty and rotate the Empty.
10. **Set up an HDRI world** — Shader Editor (World mode) → Texture Coordinate (Generated) → Mapping → Environment Texture (load .hdr/.exr) → Background → World Output.
11. **Import + clean up glTF/FBX** — Apply transforms (Ctrl+A → All), recalculate normals (Edit Mode → A → Shift+N), check for double verts (Merge by Distance, M → By Distance), rename `mixamorig:` bones if your engine fights them.
12. **Set up motion tracking** — Movie Clip Editor → load footage → add tracking markers → Track Forwards → Solve Camera Motion → Setup Tracking Scene. Composite CG into Camera view.
13. **Composite a CG element over plate** — Render with Film → Transparent on → Compositor uses Render Layers + Image (plate) + Alpha Over.
14. **Bake physics** — Physics tab → Cache → Bake. Required for Cloth/Soft Body/Fluid/Particles before final render.
15. **Particle system** — Particles tab → New → Hair (for grass/fur) or Emitter (sparks/dust). Render As: Object (instance another object) for asset scattering.
16. **Cloth simulation** — Add Cloth modifier to garment, Collision modifier to body/table. Pin verts via vertex group for hanging cloth. Bake before render.
17. **Procedural house with Geometry Nodes** — Add a Geometry Nodes modifier → Mesh Line for footprint corners → Curve to Mesh with a wall profile → Instance roof tiles on points → Realize Instances at the end if exporting.
18. **Pose a character** — Pose Mode → enable Auto-IK in header for chains without IK constraints → rotate with R, position with G. Insert keyframes with I.
19. **Apply transforms after FBX import** — Select all (A) → Ctrl+A → All Transforms. Fixes the "scale is 100" / "rotation is 90" import gotcha.
20. **Retopologize face-aware sculpt** — Quad Remesher add-on (paid, best results) or manual via Poly Build with Shrinkwrap modifier on the retopo mesh.
21. **Bake animation to keyframes** — Object → Animation → Bake Action. Use to bake constraint-driven animation into raw keyframes for export.
22. **Export glTF for web with Draco** — File → Export → glTF 2.0 → Compression → Draco mesh compression. Set quantization to 14/12/10/12/10 (position/normal/tex/color/generic) for sane size/quality balance.
23. **Export FBX for Unity/Unreal** — Apply Modifiers + Selected Objects only + Limit to Visible/Selected. For Unity: Apply Scalings = FBX Units Scale. For Unreal: leave defaults, set Forward = -Y, Up = +Z.
24. **Cycles GPU rendering** — Preferences → System → Cycles Render Devices → enable GPU. Render Properties → Cycles → Device → GPU Compute.
25. **Turntable animation** — Add Empty → parent camera to Empty → keyframe Empty rotation Z over the frame range → render animation.
26. **Low-poly game asset** — Sculpt high-poly with Multires (or sculpt + Decimate) → retopo low-poly → bake normal/AO from high to low → texture in Texture Paint or Substance.
27. **Cache simulations to disk** — Physics → Cache → set a folder path → Bake to Disk. Required for shareable/reopened scenes; in-memory cache is volatile.
28. **Auto Smooth for shading** — Object Data Properties → Normals → Auto Smooth (set angle, e.g. 30°). In 4.1+ this is replaced by the Shade Auto Smooth operator that creates a managed modifier.
29. **Copy/paste keyframes** — Select keys in Graph Editor or Dope Sheet → Ctrl+C → move playhead → Ctrl+V. Use Ctrl+Shift+V for paste-flipped (for mirrored animations).
30. **Drivers for procedural rigging** — Right-click any property → Add Driver. Open Graph Editor → Drivers mode to edit the expression and the variable bindings.

Manual recipes index: <https://docs.blender.org/manual/en/latest/getting_started/index.html>

---

## 16. Add-on Ecosystem (Durable)

**Built-in (enable in Preferences → Add-ons).**

- **Rigify** — The official auto-rig add-on. Metarig + Generate.
- **Loop Tools** — Edge loop utilities (Circle, Curve, Bridge, Flatten, Space).
- **F2** — Fill faces by hovering with F (for fast quad fills).
- **Bool Tool** — Quick boolean modifier shortcuts (Ctrl+Shift+Numpad).
- **Node Wrangler** — Indispensable shader-editor productivity. Ctrl+Shift+T = load all PBR maps from a folder. Ctrl+T = add Texture Coordinate + Mapping for a selected Image Texture.
- **Auto Mirror** — Cut a model in half and add a Mirror modifier in one click.
- **Print 3D** — Validate meshes for 3D printing (manifoldness, wall thickness).
- **glTF 2.0** — The built-in I/O. Default importer/exporter for `.glb` / `.gltf`.
- **FBX** — Built-in I/O for `.fbx`.
- **Add Mesh: Extra Objects / Add Curve: Extra Objects** — Bonus primitive libraries.
- **Blender Cloud add-on** — Pose library asset access.

**Paid / popular third-party.**

- **Hard Ops + Boxcutter** — The de-facto hard-surface modeling combo.
- **Quad Remesher** (Exoside) — Automatic quad-only retopology. The retopo answer for organic models.
- **DECALmachine** — Mesh-based decals with normal blending.
- **MACHIN3tools** — Productivity utilities (focus modes, smart drive, snap improvements).
- **Power Sequencer** — VSE additions.
- **Fluent** — Boolean-based hard-surface modeling with smart bevels.
- **Animation Layers** — Maya-style additive animation layers.
- **Auto-Rig Pro** — The popular paid alternative to Rigify with Mixamo retargeting.
- **Retopoflow** — Manual retopo toolkit (PolyStrips, PolyPen, Patches).

**Marketplaces.** Blender Market and Gumroad are the canonical paid stores. The official Blender Extensions Platform (`extensions.blender.org`) is the new built-in source for free add-ons in 4.2+.

---

## 17. Common Gotchas (the ones that bite forever)

- **Forgetting Ctrl+A → Apply Transforms** before exporting. Other engines get baffled by non-applied scale/rotation. Symptom: "armature is 100× wrong size in Unity."
- **Auto Smooth angle**. Edges sharper than the threshold render with a hard crease, smoother edges shade smoothly. Forget to set it and your bevels look faceted.
- **N-gons vs quads vs tris with Subdivision Surface.** SDS is built for quads. N-gons produce pinching; tris produce uneven shading. All-quads is the rule.
- **Modifier stack order.** Mirror **before** Subdivision Surface. Solidify **after** Subdivision (usually). Armature **before** any heavy generative modifier you want to deform with the rig.
- **Apply Rotation/Scale only.** Translates the object's origin if there's a non-zero location component baked in. Be explicit about which transforms you're applying.
- **Collection visibility eye vs camera.** The eye icon is viewport visibility; the camera icon is render visibility. They're separate. "Why isn't this in the render?" is almost always the camera icon being off.
- **The Outliner "Selectable" arrow.** Silently disables clicking the object in the viewport. Easy to toggle accidentally.
- **Cycles vs EEVEE materials.** Volumetrics, SSS, and complex BSDF combinations look very different. Always preview in the engine you'll render in.
- **Driver expressions are Python.** `var * 2` works; `var.x` for vector components; you can import math (`from math import sin`) in the Drivers expression panel preferences.
- **Bone roll and IK.** Always set bone roll explicitly (Edit Mode → Recalculate Roll → Global +Z is a common starting point). Bad rolls make IK twist unpredictably.
- **Object Mode geometry doesn't match Edit Mode.** Caused by modifiers in the stack between you and the displayed result. Toggle Edit Mode visibility on the modifier.
- **3D cursor as pivot.** If your transforms suddenly behave wrong, check the Pivot dropdown — "3D Cursor" is a common accidental setting.
- **Active object vs selected objects.** Many operators (Join, Parent, Constraints) act with respect to the active object (lighter outline). "Why did Join eat my data?" is usually wrong active object.
- **EEVEE Next probe re-bake.** Files saved in legacy EEVEE need their light probes re-baked when opened in 4.2+.
- **Live Unwrap surprise.** If Live Unwrap is on (UV Editor → UV menu), every Edit Mode tweak re-unwraps and stomps your manual UV edits. Turn off when you're done with the initial layout.

---

## knowledge[]-ready Facts

The chunks below are written as one-sentence, self-contained facts. Drop any subset into a `knowledge[]` array and they'll RAG-retrieve cleanly.

### Shortcuts

1. In Blender, G grabs (translates), R rotates, and S scales the active object — pressing X, Y, or Z after locks the operation to that world axis, and a number-then-Enter applies an exact value.
2. Holding Shift and an axis key during a transform excludes that axis, so G then Shift+Z translates within the XY plane only.
3. Pressing an axis key twice during a transform switches from world to local axes — G X X moves along the object's own X.
4. Tab toggles between Object Mode and Edit Mode; Ctrl+Tab opens a pie menu to jump straight to Sculpt, Pose, Weight Paint, and other modes when the object type supports them.
5. F3 opens Blender's universal command search bar — type any operator name to find and run it without remembering its shortcut or menu path.
6. Shift+R repeats the last operator with the same settings; Ctrl+Z and Ctrl+Shift+Z undo and redo, including operator parameter tweaks made in the F9 redo panel.
7. F12 renders a still, Ctrl+F12 renders the full animation, F11 toggles the render result window, and Esc cancels an in-progress render.

### Editors

8. The Properties panel hosts Render, Output, View Layer, Scene, World, Object, Modifiers, Particles, Physics, Object Constraints, Object Data, Material, and Texture tabs — every settings dialog in Blender lives in one of those tabs.
9. The Graph Editor edits F-curves and is where animators spend most of their time tweaking interpolation handles, easing, and curve shapes.
10. The NLA (Non-Linear Animation) Editor turns Actions into strips that can be layered, blended, and reused across characters, including additive overlays for breathing or idle motion on top of locomotion.
11. The Spreadsheet editor lets you inspect every per-vertex, per-edge, per-face, and per-instance attribute on a piece of geometry — it is the canonical Geometry Nodes debugging tool.
12. The Info editor logs every action you take as the equivalent Python call, so right-clicking a logged line and choosing Copy gives you a script that reproduces what you just did in the GUI.

### Modes

13. Edit Mode in Blender lets you switch between vertex (1), edge (2), and face (3) selection modes for meshes, while curves, armatures, lattices, and grease pencil each have their own Edit Mode tools.
14. Sculpt Mode supports three topology back-ends — Multires (subdivide-then-sculpt with bake-down), Dyntopo (per-stroke triangle adaptation), and Voxel Remesh (uniform voxel resampling) — chosen based on whether you want to preserve, refine, or rebuild topology.
15. Pose Mode is exclusive to Armature objects and is where you keyframe bone rotations, run IK constraints, and use Auto-IK for quick chain posing.
16. Weight Paint mode paints vertex group weights from 0 to 1, primarily for armature deformation but also as masks for modifiers like Vertex Weight Edit, Mask, and Hook.

### Modifiers

17. The Blender modifier stack evaluates top to bottom, so a Mirror modifier must be placed *above* Subdivision Surface for the centerline seam to merge cleanly into a smooth surface.
18. Subdivision Surface produces clean shading on all-quad topology and pinches around n-gons or triangles, so retopo for SubSurf should be quad-only wherever possible.
19. The Geometry Nodes modifier embeds a node graph in the modifier stack, allowing fully procedural geometry generation that re-evaluates on parameter change.
20. The Armature modifier is what binds a mesh to a skeleton — without it, posing bones moves the bones but not the mesh.
21. The Boolean modifier performs Union, Difference, or Intersect with another mesh; the Bool Tool add-on adds Ctrl+Shift+Numpad shortcuts for fast hard-surface boolean modeling.
22. The Multiresolution modifier subdivides a mesh several times so you can sculpt at any level and bake the highest-level detail back to a normal map for the lowest level.

### Geometry Nodes

23. In Geometry Nodes, green sockets carry geometry, purple sockets carry fields (per-element evaluation), gray sockets carry single values, and pink sockets carry strings.
24. A Field in Geometry Nodes is a function evaluated per element by its consumer — Position evaluated by Set Position runs once per vertex, but evaluated by a single-value math node returns just the head vertex's value.
25. Instances in Geometry Nodes are lightweight placeholder references; downstream nodes that need real per-vertex data require a Realize Instances node first, but realizing is expensive and should be deferred to the end of the graph.

### Shaders & Render

26. Principled BSDF is the workhorse PBR shader in Blender — its Base Color, Metallic, Roughness, IOR, Normal, Emission, and Alpha inputs cover the vast majority of material needs across both Cycles and EEVEE.
27. Cycles is Blender's path-traced reference renderer with GPU support via OptiX (NVIDIA), CUDA, HIP (AMD), Metal (Apple Silicon), and OneAPI (Intel), while EEVEE Next is the real-time PBR rasterizer with screen-space reflections, screen-space global illumination, and raytraced shadows in 4.2+.
28. The standard HDRI world setup in Blender is Texture Coordinate (Generated) → Mapping → Environment Texture → Background → World Output in the Shader Editor's World mode.
29. Always pick a perceptual View Transform in Color Management — Filmic has been the cinematic default for years and AgX is the modern more-neutral option in 4.x; the raw Standard transform clips highlights ungracefully.

### Animation

30. Press I in the 3D Viewport to open the Insert Keyframe menu and pick exactly which channels (Location, Rotation, Scale, Available, etc.) to keyframe; Auto Keyframe (the timeline's red dot) keys automatically as you transform.
31. The Graph Editor's interpolation menu (T) offers Constant, Linear, Bezier, Sinusoidal, Quadratic, Cubic, Quartic, Quintic, Exponential, Circular, Bounce, Elastic, and Back — Bezier with hand-tuned handles is the default and most expressive option.
32. Drivers in Blender are Python expressions that bind one property's value to the value of another — right-click any property and choose Add Driver to wire it up, then edit the expression in the Graph Editor's Drivers mode.
33. The NLA workflow is Action → Push Down → Strip, after which strips can be blended, scaled, and layered with Replace, Add, Subtract, or Combine blend modes for additive idle and overlay animation.

### Rigging

34. Rigify is Blender's built-in auto-rig add-on — add a Metarig matching your character's limbs and torso, fit it to the mesh, then click Generate to produce a full FK/IK control rig.
35. IK constraints in Blender need a Chain Length set on the IK constraint and a pole target empty placed beside the elbow or knee to control the bend direction.
36. Mixamo rigs prefix every bone with `mixamorig:` (e.g. `mixamorig:Hips`); most retargeting and animation-layer add-ons rely on the prefix, so don't strip it without a reason.

### Sculpting

37. Sculpt Mode brushes share Smooth on Shift-hold and Mask on M-hold, and Face Sets (Ctrl+W to assign, W to expand) group polygons for Pose, Boundary, and Edit-Face-Set workflows.
38. Multires preserves clean retopology underneath sculpted detail and lets you bake the high-frequency detail to a normal map for the low-poly base — Dyntopo and Voxel Remesh trade that for free-form topology changes during sculpting.

### UV

39. Mark Seam (Ctrl+E → Mark Seam) defines the cuts that the U → Unwrap operator uses, while Smart UV Project auto-cuts by an angle threshold and Pack Islands fits everything into the 0–1 UV square.
40. The standard character unwrap workflow is mark seams along symmetry plus naturally hidden edges (back of ear, hairline, armpit) → Unwrap → Average Islands Scale → Pack Islands.

### Python

41. Use `bpy.data` to mutate Blender's data reliably from any context (`bpy.data.objects['Cube']`), and use `bpy.ops` only when there is no direct data API for the operation you need — operators depend on context and can fail silently in headless scripts.
42. Render headlessly with `blender -b file.blend -o //out_ -F PNG -f 1` for a single frame or `-a` for the full animation; `-P script.py` runs a Python script against the scene before rendering.
43. The Info editor logs every GUI action as Python — right-click a logged line, copy it, and paste into the Text Editor to script anything you can do by hand.

### Render

44. Cycles samples + Adaptive Sampling + OptiX or OpenImageDenoise denoising is the standard quality recipe; 1024 samples + adaptive + denoise yields production-quality output without long render times for most scenes.
45. EEVEE Next requires baking light probes (Reflection Plane, Reflection Cubemap, Irradiance Volume) for indirect lighting, and old EEVEE files need their probes re-baked after upgrading to 4.2+.

### Compositor & VSE

46. The Blender Compositor adds Glare for bloom, Lens Distortion for chromatic aberration, Defocus for depth-of-field, and Cryptomatte for per-object mask grading — all wired between the Render Layers input and the Composite output.
47. Blender's Video Sequence Editor is a real video editor — Add Strip → Movie/Image/Sound, Adjustment Layer for stacked grades, Speed Control for re-timing, and Render → File Format = FFmpeg Video to export an MP4.

### Asset Browser

48. Mark anything (Object, Material, World, Action, Node Group, Pose) as an Asset via right-click in the Outliner, then add the containing folder under Preferences → File Paths → Asset Libraries to make it available across projects via drag-drop from the Asset Browser.

### Recipes

49. Always Ctrl+A → Apply All Transforms before exporting to glTF or FBX — non-applied scale and rotation cause sibling tools (Unity, Unreal, Three.js) to import the asset at 100× or wrong-axis size.
50. To bake a normal map from a high-poly to a low-poly: enable Cycles, add an Image Texture node to the low-poly material (selected but unconnected), select high-poly first then low-poly, enable Selected to Active in Bake settings, set Bake Type to Normal, and bake.
51. To export glTF for the web with Draco compression: File → Export → glTF 2.0, enable Draco mesh compression, and use 14/12/10/12/10 quantization for position/normal/texcoord/color/generic for a sane size-versus-quality balance.

### Add-ons

52. Node Wrangler is the indispensable shader-editor productivity add-on — Ctrl+Shift+T loads all PBR maps from a folder onto the active material in one click, and Ctrl+T adds a Texture Coordinate plus Mapping pair to the selected Image Texture.
53. Hard Ops + Boxcutter is the de-facto paid combo for hard-surface modeling, while Quad Remesher is the canonical answer for automatic quad-only retopology of organic sculpts.

### Gotchas

54. The Outliner has separate eye (viewport) and camera (render) visibility icons, plus a hidden Selectable arrow — "this object isn't in my render" is almost always the camera icon being off, and "I can't click this object" is almost always the Selectable arrow being off.
55. Bone roll affects IK twist behavior, so always Recalculate Roll explicitly (Edit Mode → Armature → Bone Roll → Recalculate, with a global axis like +Z) when rigging — bad rolls produce unpredictable elbow and knee twists during IK animation.

---

**Manual root:** <https://docs.blender.org/manual/en/latest/>
**Python API:** <https://docs.blender.org/api/current/>
**Default keymap:** <https://docs.blender.org/manual/en/latest/interface/keymap/blender_default.html>
