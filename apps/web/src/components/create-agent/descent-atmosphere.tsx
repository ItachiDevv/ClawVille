'use client';

/**
 * DescentAtmosphere — the shared underwater backdrop for the sign-up flow
 * ("The Descent": /login → /create-agent → /create-agent/personality).
 *
 * Pure CSS layers, zero WebGL/WebGPU cost: depth gradient + drifting marine
 * snow + breathing god rays + vignette. Every animated layer moves via
 * transform/opacity only (compositor-safe on Iris Xe) and freezes under
 * prefers-reduced-motion (globals.css owns the keyframes).
 *
 * `depth` deepens the water as the user descends through the flow:
 *   surface — /login (lagoon light, strongest rays)
 *   forge   — /create-agent (mid-water)
 *   soul    — /create-agent/personality (abyss, rays almost gone)
 */

export type DescentDepth = 'surface' | 'forge' | 'soul';

const DEPTH_GRADIENT: Record<DescentDepth, string> = {
  surface:
    'linear-gradient(180deg, #0a2b42 0%, #072033 38%, #051524 72%, #04101d 100%)',
  forge:
    'linear-gradient(180deg, #072033 0%, #051a2b 45%, #04121f 100%)',
  soul:
    'linear-gradient(180deg, #051524 0%, #040f1b 50%, #030b14 100%)',
};

/** Ray opacity multiplier per depth — light dies as you sink. */
const RAY_OPACITY: Record<DescentDepth, number> = {
  surface: 1,
  forge: 0.55,
  soul: 0.22,
};

export function DescentAtmosphere({ depth }: { depth: DescentDepth }) {
  const rayOpacity = RAY_OPACITY[depth];
  return (
    // FIXED to the viewport, not absolute over the document: the Soul page is
    // several viewports tall, and a document-spanning snow layer at 300%
    // height + will-change promoted a huge GPU layer (Codex review BLOCKING
    // 1). Viewport-fixed bounds every layer to ~3 screen heights max and
    // gives the backdrop a gentle parallax feel for free.
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
      {/* Depth gradient */}
      <div className="absolute inset-0" style={{ background: DEPTH_GRADIENT[depth] }} />

      {/* Bioluminescent drift glows */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 40% at 18% 78%, rgba(53,224,255,0.07) 0%, transparent 70%), radial-gradient(ellipse 45% 35% at 84% 22%, rgba(53,224,255,0.05) 0%, transparent 70%)',
        }}
      />

      {/* God rays, angled from upper left like sun through water. Brightness
          rides --ray-max (consumed by the keyframes) so depth dimming holds
          while the breathe animation runs. */}
      <div
        className="descent-ray"
        style={{ left: '14%', transform: 'rotate(16deg)', ['--ray-max' as string]: rayOpacity, animationDelay: '0s' } as React.CSSProperties}
      />
      <div
        className="descent-ray"
        style={{ left: '34%', width: 90, transform: 'rotate(20deg)', ['--ray-max' as string]: rayOpacity * 0.7, animationDelay: '-3.5s' } as React.CSSProperties}
      />
      <div
        className="descent-ray"
        style={{ left: '58%', width: 170, transform: 'rotate(13deg)', ['--ray-max' as string]: rayOpacity * 0.5, animationDelay: '-6.5s' } as React.CSSProperties}
      />

      {/* Marine snow — far and near layers drifting upward as we sink */}
      <div className="descent-snow" style={{ opacity: 0.7 }} />
      <div className="descent-snow descent-snow--near" style={{ opacity: 0.5 }} />

      {/* Vignette settles the frame */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 120% 90% at 50% 42%, transparent 55%, rgba(2,8,15,0.55) 100%)',
        }}
      />
    </div>
  );
}
