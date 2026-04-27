---
title: WebGPU depth buffer allocated at 300×150 before CSS layout resolves
category: gotcha
tags: [webgpu, depth-stencil, canvas, resize, R3F, init, layout]
date: 2026-04-27
confidence: high
threejs_version: r182+
---

## Summary

When using an async `gl` factory with R3F v9, `new WebGPURenderer({ canvas })` must not be called before the canvas has its true CSS dimensions stamped on `canvas.width`/`canvas.height` — otherwise `init()` allocates the depth buffer at 300×150 (the HTML default) and `setSize()` later only resizes color attachments, leaving a permanently mismatched depth attachment that causes every `BeginRenderPass` to fail.

## Details

R3F v9 supports `<Canvas gl={asyncFactory}>`. The factory receives the `HTMLCanvasElement` already inserted into the DOM. **But** the factory runs before the browser has flushed the CSS layout pass — so `canvas.width` and `canvas.height` are still the HTML defaults: 300 and 150.

`WebGPURenderer.init()` internally calls `_textures.initDepthTexture(canvas.width, canvas.height)`. That allocates a `GPUTexture` for the depth/stencil attachment at 300×150.

R3F's ResizeObserver fires after the first paint and calls `renderer.setSize(trueW, trueH)`. In Three.js r182, `WebGPURenderer.setSize()` resizes the swap-chain color attachment via `backend.updateSize()` but does **not** destroy and reallocate the depth texture. Result: color attachments are 1256×825, depth is 300×150. WebGPU validation rejects every `BeginRenderPass` with:

```
The depth stencil attachment size (width: 300, height: 150) does not match
the size of the other attachments' base plane (width: 1256, height: 825).
```

This floods the console, kills all rendering, and triggers "too many warnings" suppression.

## Fix

Call `getBoundingClientRect()` **before** constructing the renderer. This forces a synchronous layout reflow and returns the true CSS dimensions. Stamp them on `canvas.width`/`canvas.height` if non-zero, then construct the renderer.

```ts
const rect = canvas.getBoundingClientRect();
const cssW = Math.round(rect.width);
const cssH = Math.round(rect.height);
if (cssW > 0 && cssH > 0) {
  canvas.width  = cssW;
  canvas.height = cssH;
}
const renderer = new WebGPURenderer({ canvas, antialias: false });
await renderer.init();
```

`getBoundingClientRect()` triggers a synchronous reflow — the CSS layout resolves before the call returns. If for some reason the parent hasn't laid out yet (`cssW === 0`), the guard skips the stamp and R3F's ResizeObserver will call `setSize()` immediately after the first paint anyway. In practice with `position: absolute; width: 100%; height: 100%` wrapping divs, `getBoundingClientRect()` always returns real dimensions.

## When This Gets Triggered

Anything that defers the canvas mount slightly can expose this: adding a `layout.tsx` above a `'use client'` page (changes the hydration order), mounting a new DOM component before the Canvas, or any SSR change that shifts the React commit timing.

In ClawVille, the `52aeedc` commit that added `apps/web/src/app/game/layout.tsx` (server component with `dynamic = 'force-dynamic'`) changed the hydration sequence just enough to push the async `gl` factory earlier in the lifecycle — before CSS layout had resolved.

## Context

Diagnosed 2026-04-27. Manifested after `52aeedc` added `game/layout.tsx`. The 300×150 dimensions are the HTML5 spec default for `<canvas>` when `width`/`height` attributes are absent. Fix applied in `World3DCanvas.tsx` `createWebGPURenderer()`. The `layout.tsx` itself was not the bug — it was correct; the canvas init just needed to handle pre-layout dimensions.
