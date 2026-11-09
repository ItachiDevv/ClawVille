# Laptop renderer evidence

Observed on hoodie-prometh at 2026-11-09T15:38Z through a separate headless Chrome157 profile.
The desktop served the production bundle through loopback SSH forwarding.
No user browser session changed.

SystemInfo identifies Intel Iris Xe, driver32.0.101.7092.
The default scene selected WebGLBackend through the existing integrated-GPU policy.
The office and guide rendered in the viewed1440x1000 capture.
The HUD still displayed WebGPU; use the actual renderer backend for evidence.

An explicit webgpu=1 comparison used WebGPUBackend and device.adapterInfo identified intel/gen-12lp.
The captured3D scene was black. HTML controls remained visible.
This comparison does not pass visual verification.
Keep the existing default WebGL2 policy. Do not infer a building-specific cause from this headless comparison.
The default screenshot predates the override and remains the visual evidence for the supported laptop path.

Evidence JSON:laptop-browser-gpu-evidence.json,laptop-scene-webgl-evidence.json,laptop-scene-webgpu-evidence.json.
Ignored captures:.brainchain-work/laptop-office-webgl-1440.png and laptop-office-webgpu-black.png.
These headless checks do not establish foreground sustained FPS or a before/after performance comparison.
The fixture also has API/feed network errors; it does not prove live service health.

