/**
 * The client-only Cove HUD is dynamic for the same stale chunk-graph reason as
 * `/game`: the shared `(world)` stage must never be booted from edge-cached HTML
 * that references an obsolete production bundle.
 */
export const dynamic = 'force-dynamic';

export default function CoveLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
