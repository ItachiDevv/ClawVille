# TouchDesigner — A Working Knowledge Base for the Canvas Studio Agent

> Compiled 2026-05-01. Recency bias on past 30 days. [STABLE] = older but current. [NEW] = past 30 days.

---

## 1. What it is + the operator model

TouchDesigner is a node-based visual programming environment from Derivative for real-time interactive multimedia — VJ shows, projection mapping, installations, AI-driven visuals, projection on LED walls, and prototyping. Everything is an **Operator (OP)**. You wire OPs together left-to-right; data flows along those wires; the system **cooks** (recalculates) only the OPs whose inputs have changed since the last frame.

**Six OP families:**

- **TOPs (Texture Operators)** — 2D pixel/image data on the GPU. The bread and butter.
  - `Movie File In TOP` loads images, image sequences, and movies (HAP, ProRes, H.264, etc.)
  - `Movie File Out TOP` records a TOP stream to disk.
  - `Render TOP` rasterizes a 3D scene defined by Camera + Geometry COMPs + Light COMPs.
  - `Constant TOP` outputs a flat color.
  - `Composite TOP` / `Over TOP` blend layers.
  - `GLSL TOP` lets you write a custom pixel shader.
  - `NDI In TOP` / `NDI Out TOP` send/receive video over the network.
  - `Syphon Spout In TOP` / `Syphon Spout Out TOP` share textures with other apps on the same machine.
  - `Kinect Azure TOP` captures color/depth/IR from an Azure Kinect or compatible Orbbec sensor.
  - `Nvidia Upscaler TOP` AI-upscales using NVIDIA's Maxine SDK.

- **CHOPs (Channel Operators)** — time-series data: `Constant CHOP`, `LFO CHOP`, `Noise CHOP`, `Audio File In CHOP`, `Audio Spectrum CHOP`, `Audio Analysis CHOP`, `MIDI In CHOP`, `OSC In CHOP` / `OSC Out CHOP`, `DMX In CHOP` / `DMX Out CHOP`, `Kinect Azure CHOP`, `Ableton Link CHOP`.

- **SOPs (Surface Operators)** — CPU-side 3D geometry. Older, slower for real-time. Being superseded by POPs.

- **POPs (Point Operators)** — [NEW] the high-performance GPU 3D family introduced in 2025.x and expanded in build **2025.32460 (released March 10, 2026)** with `Text POP`, `Trace POP`, `Triangulate POP`, `Alembic Out POP`. Designed from the ground up for the GPU.

- **MATs (Materials)** — shaders/materials for 3D geometry: `Phong MAT`, `PBR MAT`, `GLSL MAT`, `Constant MAT`, `Wireframe MAT`.

- **DATs (Data Operators)** — text, tables, code: `Text DAT`, `Table DAT`, `Execute DAT`, `CHOP Execute DAT`, `Parameter Execute DAT`, `Web Client DAT`, `WebSocket DAT`, `OSC In DAT`, `MQTT Client DAT`, `Script DAT`.

- **COMPs (Components)** — containers and 3D objects: `Container COMP` (UI), `Geometry COMP` (3D object), `Camera COMP`, `Light COMP`, `Base COMP`, `Window COMP`.

Networks, parameters, panels, time, cooks — every OP lives inside a network; every OP has parameters that can be constants, expressions, or **exports** from CHOP channels (`chan('chanName')`). Time advances each frame; the **cook** is per-frame recalculation triggered by dirty inputs.

---

## 2. Editions + pricing 2026

| Edition | Price USD | Notes |
|---|---|---|
| **Non-Commercial** | **Free** | Personal/learning. **1280×1280 cap** on most TOPs. No Shared Memory OPs, no C++ TOP, no SDI, no NDI Out. Forum support only. |
| **Educational** | **$300** | Same feature set as Commercial; verified students/teachers. |
| **Commercial** | **$600** node-locked / **$900** floating-cloud | Full feature set minus Pro-only operators. |
| **Pro** | **$2200** new (upgrade from Commercial **$1600**) | Adds Pro-only ops (SDI, Engine COMP for headless `.tox`) plus 6h Pro Support. |

Non-Commercial does NOT stamp a watermark but cooks at the 1280×1280 cap.

---

## 3. Python + GLSL

**Python lives in DATs.** Embedded CPython 3.11. Install third-party packages via `pip` and point TD's Python Module Path preference at site-packages. DAT types: `Text DAT`, `Execute DAT` (lifecycle: `onStart`, `onCreate`, `onExit`), `CHOP Execute DAT` (`onValueChange`), `Parameter Execute DAT`, `Panel Execute DAT`.

```python
# In a Text DAT
val = op('slider1')['v1']                 # CHOP channel cell
op('constant1').par.colorr = val          # set parameter on another OP
op('moviefilein1').par.play.pulse()       # trigger pulse parameter
for cell in op('table1').rows():
    debug(cell[0].val, cell[1].val)
```

`me` refers to the containing DAT in scripts; `me.op('..')` returns parent. Expressions on parameters use the same Python.

**GLSL lives in TOPs and MATs.** `GLSL TOP` runs a fragment shader per output pixel. `GLSL Multi TOP` for multi-input shaders. `GLSL MAT` for vertex+fragment material shaders.

```glsl
// Pixel shader inside a GLSL TOP
uniform float u_time;
out vec4 fragColor;
void main() {
    vec2 uv = vUV.st;
    float wave = sin(uv.x * 10.0 + u_time * 2.0);
    fragColor = TDOutputSwizzle(vec4(uv, wave, 1.0));
}
```

`TDOutputSwizzle()` is TD's required pixel-output wrapper — handles platform colorspace conversion. Always use it on the final write or the image will look wrong on macOS.

---

## 4. Real-time AI integration

### StreamDiffusionTD (DotSimulate) [NEW]
Real-time Stable Diffusion inside TouchDesigner — feed any TOP in, get a generated TOP out at ~10–30 fps. Latest is **v0.3.1** — install in a fresh folder, do not upgrade in place. Requires NVIDIA RTX, Windows, CUDA. Free OSS alternative: olegchomp/TouchDiffusion.

### ComfyUI bridge [NEW]
Two production paths:
- **TDComfyUI** by olegchomp — TD-side `.tox` driving an external ComfyUI server via REST.
- **ComfyUI-TD** by JiSenHua — ComfyUI custom node streams images/video/audio out to TD over WebSocket.
- DotSimulate's **ComfyTD** is the polished commercial wrapper used in the [April 2026 tutorial drop](https://derivative.ca/community-post/integrating-comfyui-touchdesigner/72715).

Pattern: ComfyUI runs SDXL/Flux/SUPIR/SAM 3.1 on a separate process; TouchDesigner sends prompts + masks + control images; ComfyUI returns frames as a TOP stream. ComfyUI v0.20.1 (2026-04-27) added SUPIR + SAM 3.1 that pair particularly well with TD masking.

### TDAI ecosystem
Community packages on AllTouchDesigner ([alltd.org](https://www.alltd.org/)) and DotSimulate's Patreon. **DotSimulate LOPs** (LLM Operators) v0.1.1 surface LLM intelligence as TouchDesigner nodes.

### NVIDIA Upscaler TOP / Maxine
`Nvidia Upscaler TOP` wraps Maxine: *Upscale Filter* (fast, 2×/3×/4×) and *Super-Resolution Filter* (specific in→out pairs, slower, higher quality). Sister TOPs: `Nvidia Background TOP`, `Nvidia Denoise TOP`. **No native DLSS** in TD as of build 2025.32460.

### LLM API calls from a Python DAT
```python
import os, openai
client = openai.OpenAI(api_key=op('apikey').text)
resp = client.chat.completions.create(
    model='gpt-4o-mini',
    messages=[{'role':'user', 'content': op('prompt_input').text}]
)
op('llm_out').text = resp.choices[0].message.content
```
Same shape works for Anthropic and Google Gemini.

### OSC / WebSocket / MQTT — let an external agent drive TD
- **OSC** — `OSC In CHOP` for control values (~1ms).
- **WebSocket** — `WebSocket DAT` runs as client or server. Server mode lets a browser-side AI agent push JSON into a running TD project.
- **MQTT** — `MQTT Client DAT` for pub/sub on a broker.

---

## 5. Hardware + protocol integration

- **NDI** — `NDI In/Out TOP`. ~10–60 ms latency at 60 fps; CPU-encoded, network-routable. Non-Commercial cannot use NDI Out.
- **Spout (Win) / Syphon (Mac)** — `Syphon Spout In/Out TOP`. Same-machine GPU-shared textures, zero network. Spout supports up to 32-bit float RGBA; Syphon caps at 8-bit RGBA.
- **MIDI** — `MIDI In CHOP` + `MIDI Out CHOP`.
- **DMX / Art-Net / sACN / KiNET** — `DMX In/Out CHOP`. 5–15 ms latency.
- **Kinect Azure / Orbbec Femto** — `Kinect Azure TOP` (depth/IR/color) + `Kinect Azure CHOP` (32-joint skeleton, IMU).
- **Projection mapping** — built-in palette tools: **`kantanMapper` COMP** (2D bezier/polygon) and **`camSchnappr` COMP** (3D-aligned).
- **OpenXR** — Meta Quest, Valve Index, Apple Vision Pro via PCVR.

---

## 6. Use case map

| Use case | Workflow + key OPs |
|---|---|
| **Live VJ + audio reactivity** | `Audio Device In CHOP` → `Audio Spectrum CHOP` → `Math CHOP` smoothing → export to GLSL TOP uniforms or Geometry COMP transforms. Add `MIDI In CHOP` for an APC/Launchpad. Output via `Window COMP` or `NDI Out TOP`. TDAbleton for tight Ableton sync. |
| **Projection mapping** | `Render TOP` → `kantanMapper` (flat surfaces) or `camSchnappr` (3D-aligned) → `Window COMP` to projector. Pixel-mapped LEDs: import OBJ → vertex-sample TOP into CHOP → DMX/sACN out. |
| **Real-time AI in a club** | `Video Device In TOP` → mask → StreamDiffusionTD or TDComfyUI → `Nvidia Upscaler TOP` → blend → projector. Drive prompt via OSC from phone or LLM. |
| **Data dashboard** | `Web Client DAT` polls API → JSON → `Table DAT` → CHOP channels → drive shapes/text. New `Text POP` for 3D vector text. |
| **Interactive installation** | `Kinect Azure TOP/CHOP` skeleton → CHOP smoothing → drive Geometry COMP transforms or GLSL TOP uniforms. Use `Trigger CHOP` for gesture detection. |
| **Game cinematics / pre-rendered** | Build with POPs/Geometry COMPs, render to `Render TOP`, output to `Movie File Out TOP` (HAP or ProRes). Or export `.tox` for ingestion into Unreal via TouchEngine. |
| **LED wall / volumetric video** | HAP or HAP-Q via `Movie File In TOP`. For LED walls: pixel-mapped sampling. Genlock: NDI Out or SDI Out (Pro tier). [TD-Lightwork](https://github.com/timrolls/TD-Lightwork) wraps the pattern. |

---

## 7. What shifted past 30 days

- **2026-04-10** — DotSimulate's "ComfyTD" tutorial drop (end-to-end ComfyUI from TD).
- **2026-04-27** — ComfyUI v0.20.1 ships SUPIR + SAM 3.1, immediately consumable by TDComfyUI / ComfyUI-TD bridges.
- **March 10, 2026** — TouchDesigner build **2025.32460** released. New POPs: `Text POP`, `Trace POP`, `Triangulate POP`, `Alembic Out POP`. Bug fixes for ray-tracing GLSL/Ray POPs, TouchEngine texture-output stability. Rec.709 Gamma 2.4 colorspace option.
- **StreamDiffusionTD v0.3.1** is current shipping version with revamped installer; never upgrade v0.3.0 in place.
- **DotSimulate LOPs v0.1.1** — LLM Operators family expanded.

---

## 8. Headless / production angle

- **`.tox` files** — single component exported as portable file. The unit of TD modularity.
- **`.toe` files** — full-project TouchDesigner files.
- **TouchEngine** — embed a `.tox` inside Unreal/Unity/Max/Notch/Disguise running a headless TD subprocess. Sub-millisecond shared-memory, **no licensing fee on the host side**. [TouchEngine-UE plugin](https://github.com/TouchDesigner/TouchEngine-UE).
- **Engine COMP** — load a `.tox` headlessly inside another TD project; sandbox crashy sub-graphs.
- **Perform Mode** — strips editor UI, runs project full-screen at max performance. F1 or `ui.performMode = True`.
- **TDAbleton** — bidirectional bridge to Ableton Live via OSC + MIDI Remote Scripts + Max-for-Live.
- **CLI** — `TouchDesigner.exe project.toe --PerformOnStart` for kiosk installs.
- **No first-party "TD Server"** — community pattern: spin up `WebSocket DAT` server, expose JSON-RPC.
- **Docker** — TD does NOT run inside Docker on Linux (no Linux build); Windows containers with GPU passthrough are workable.

---

## 9. Common gotchas

- **Cooking order** — put static work early, dynamic late. Rearrangement can drop cook time 0.25ms → 0.06ms.
- **Dependent cook loops** — circular references cook every frame forever.
- **Texture format mismatches** — silently force CPU↔GPU readbacks.
- **CHOP cooking explosion** — multi-channel CHOP causes everything downstream to cook on any channel change. Use `CHOP Execute DAT` to selectively forward.
- **Non-Commercial 1280×1280 cap** — silently clips your beautiful 4K project.
- **NaN propagation** — divide-by-zero or asin(>1) poisons every channel downstream until `Limit CHOP`.
- **Python lifecycle** — `onStart` once on load; `onCreate` on every project open; `onValueChange` every frame value differs. Don't put expensive setup in `onValueChange`.
- **`TDOutputSwizzle()`** missing from a GLSL TOP fragment shader → wrong colors on macOS.

---

## 10. Resources

- **Official docs** — [docs.derivative.ca](https://docs.derivative.ca/) and [derivative.ca/UserGuide](https://derivative.ca/UserGuide/Main_Page).
- **Tutorial creators:** Bileam Tschepe (elekktronaut), Matthew Ragan, Paketa12, Crystal Jow, DotSimulate (AI/LLM-native).
- **The Interactive & Immersive HQ** ([interactiveimmersive.io](https://interactiveimmersive.io/)) — long-form blog + courses.
- **AllTouchDesigner** ([alltd.org](https://www.alltd.org/)) — community aggregator.
- **Discord** — official "TouchDesigner Help" Discord (invite via [forum.derivative.ca](https://forum.derivative.ca/)) and DotSimulate's Discord.
- **GitHub:** [TouchDesigner (official)](https://github.com/TouchDesigner), [olegchomp/TDComfyUI](https://github.com/olegchomp/TDComfyUI), [JiSenHua/ComfyUI-TD](https://github.com/JiSenHua/ComfyUI-TD), [imehlee/TouchDesigner-OpenAI-API](https://github.com/imehlee/TouchDesigner-OpenAI-API), [timrolls/TD-Lightwork](https://github.com/timrolls/TD-Lightwork).
