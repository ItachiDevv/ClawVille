// @ts-nocheck
/**
 * <MeshletBuildingsR3F /> — R3F-mounted coordinator for a separate transparent
 * WebGPU overlay canvas that draws only the meshlet building layer.
 *
 * Why not share R3F's renderer:
 *   /game?webgpu=1 currently renders a blank world on the local Iris Xe path,
 *   while the standalone meshlet preview renders correctly. Therefore the
 *   guarded meshlet path must keep the production R3F scene on its existing
 *   WebGL/WebGLBackend path and use WebGPU only for the building overlay.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { NaniteRasterizer } from '@/lib/three/experimental/nanite-rasterizer';
import { useMergedBuildingsAsset } from './use-merged-buildings-asset';
import { RING_BOUNDING_RADIUS } from './buildings-manifest';

export default function MeshletBuildingsR3F() {
  const { gl, size } = useThree();
  const { asset, state } = useMergedBuildingsAsset();
  const [overlayCanvas, setOverlayCanvas] = useState<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGPURenderer | null>(null);
  const rasterizerRef = useRef<NaniteRasterizer | null>(null);
  const readyRef = useRef(false);
  const inFlightRef = useRef(false);
  const lastSizeRef = useRef({ width: 0, height: 0, dpr: 0 });

  useEffect(() => {
    const host = gl.domElement.parentElement;
    if (!host) return;

    const previousPosition = host.style.position;
    if (!previousPosition) host.style.position = 'relative';

    gl.domElement.style.position = 'absolute';
    gl.domElement.style.inset = '0';
    gl.domElement.style.zIndex = '0';

    const canvas = document.createElement('canvas');
    canvas.dataset.meshletBuildingsLayer = 'true';
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '1',
      pointerEvents: 'none',
      background: 'transparent',
    });
    host.appendChild(canvas);
    canvasRef.current = canvas;
    setOverlayCanvas(canvas);

    return () => {
      canvasRef.current = null;
      setOverlayCanvas(null);
      canvas.remove();
      if (!previousPosition) host.style.position = previousPosition;
    };
  }, [gl]);

  useEffect(() => {
    if (!asset || !overlayCanvas) return;
    let cancelled = false;

    (async () => {
      try {
        if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
          console.warn('[MeshletBuildingsR3F] WebGPU unavailable — skipping meshlet overlay.');
          return;
        }

        const renderer = new THREE.WebGPURenderer({
          canvas: overlayCanvas,
          antialias: false,
          alpha: true,
          forceWebGL: false,
        });
        rendererRef.current = renderer;
        (renderer as any).setClearColor?.(0x000000, 0);
        (renderer as any).autoClear = true;
        await renderer.init();
        if (cancelled) {
          renderer.dispose();
          return;
        }

        console.log('[MeshletBuildingsR3F] overlay init complete — backend:',
          (renderer as any).backend?.constructor?.name,
          'isWebGPU:', (renderer as any).isWebGPURenderer);

        const _sc = (asset as any).sourceColors;
        if (_sc) {
          const colorPreview: string[] = [];
          for (let i = 0; i < _sc.length / 3; i++) {
            colorPreview.push(`#${i}: ${_sc[i*3].toFixed(2)},${_sc[i*3+1].toFixed(2)},${_sc[i*3+2].toFixed(2)}`);
          }
          console.log('[MeshletBuildingsR3F] sourceColors in asset:', colorPreview.join(' | '));
        } else {
          console.warn('[MeshletBuildingsR3F] asset has no sourceColors field!');
        }
        const r = new NaniteRasterizer(renderer, asset, {
          instanceCount: 1,
          staticInstanceData: new Float32Array([0, 0, 0, 1]),
          maxRasterSize: 16,
          instanceBoundingRadius: RING_BOUNDING_RADIUS,
          pixelErrorThreshold: 0, // force LOD 0 — proven 167 FPS in spike
          // v3 atlas: real building diffuse textures sampled via the same
          // working `texture(atlas, uv).grad()` codepath as the Three.js
          // example's PBR mode. Per-vertex UVs were remapped into atlas
          // slots in use-merged-buildings-asset.ts.
          materialMode: 1,
        });
        await r.init();
        if (cancelled) {
          r.dispose();
          return;
        }
        rasterizerRef.current = r;
        readyRef.current = true;
      } catch (err) {
        console.error('[MeshletBuildingsR3F] init failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      rasterizerRef.current?.dispose();
      rasterizerRef.current = null;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [asset, overlayCanvas]);

  const frameCountRef = useRef(0);
  useFrame((state) => {
    const renderer = rendererRef.current;
    const rasterizer = rasterizerRef.current;
    const overlayCanvas = canvasRef.current;
    if (!readyRef.current || !renderer || !rasterizer || !overlayCanvas || inFlightRef.current) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 1);
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    const last = lastSizeRef.current;
    if (last.width !== width || last.height !== height || last.dpr !== dpr) {
      last.width = width;
      last.height = height;
      last.dpr = dpr;
      overlayCanvas.width = Math.round(width * dpr);
      overlayCanvas.height = Math.round(height * dpr);
      (renderer as any).setPixelRatio?.(dpr);
      renderer.setSize(width, height, false);
    }

    frameCountRef.current += 1;
    const logThisFrame = frameCountRef.current === 1 ||
                         frameCountRef.current === 60 ||
                         frameCountRef.current === 300;
    inFlightRef.current = true;
    (renderer as any).autoClear = true;
    rasterizer.render(
      state.camera as THREE.PerspectiveCamera,
      width,
      height,
    ).then(() => {
      if (logThisFrame) console.log('[MeshletBuildingsR3F] frame', frameCountRef.current, 'transparent overlay OK');
    }).catch((err) => {
      console.error('[MeshletBuildingsR3F] rasterizer render failed:', err);
    }).finally(() => {
      inFlightRef.current = false;
    });
  });

  // No React DOM output — the overlay canvas is imperatively attached next to
  // R3F's canvas so the main scene can stay on the stable WebGL path.
  return null;
}
