'use client';

/**
 * /preview/cosmetics — dev/QA only route
 *
 * Renders 5 humanoid VRMs side-by-side, each wearing a hat and glasses,
 * so the cosmetic head-fit algorithm (computeCosmeticHeadFit) can be
 * verified visually across all avatar types.
 *
 * IMPORTANT: Uses a DEFAULT WebGL renderer (not WebGPU) so that
 * chrome-devtools MCP can capture screenshots (WebGPU swapchain is not
 * capturable by CDP screenshotting). Never import from 'three/webgpu' here.
 *
 * Iris Xe constraints still apply to this file (no drei <Text>/<Billboard>,
 * no InstancedMesh + ShaderMaterial, no per-frame new Vector3()), though
 * this is a QA route and is WebGL — so drei Html labels are safe here.
 */

import dynamic from 'next/dynamic';

const CosmeticsPreviewScene = dynamic(
  () => import('./CosmeticsPreviewScene'),
  { ssr: false },
);

export default function CosmeticsPreviewPage() {
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0a1628', position: 'relative' }}>
      <div style={{
        position: 'absolute',
        top: 8,
        left: 8,
        color: '#7dd3fc',
        fontFamily: 'monospace',
        fontSize: 12,
        zIndex: 10,
        pointerEvents: 'none',
      }}>
        /preview/cosmetics — dev/QA only — WebGL (screenshottable)
      </div>
      <CosmeticsPreviewScene />
    </div>
  );
}
