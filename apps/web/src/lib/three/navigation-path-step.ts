export type NavigationPoint = Readonly<{ x: number; y: number }>;
export type NavigationStep = { x: number; y: number; index: number; traveled: number; vx: number; vy: number; complete: boolean };
export function createNavigationStep(): NavigationStep { return { x: 0, y: 0, index: 0, traveled: 0, vx: 0, vy: 0, complete: false }; }
/** Spend one frame's distance along each segment, with a collision check at every turn. */
export function stepNavigationPath(points: readonly NavigationPoint[], index: number, x: number, y: number, budget: number,
  move: (x: number, y: number, targetX: number, targetY: number) => NavigationPoint, out: NavigationStep, arrivalTolerance = 0.0001): NavigationStep {
  out.x = x; out.y = y; out.index = index; out.traveled = 0; out.vx = 0; out.vy = 0; out.complete = false;
  while (out.index < points.length) {
    const target = points[out.index], dx = target.x - out.x, dy = target.y - out.y;
    const distance = Math.hypot(dx, dy);
    const tolerance = out.index === points.length - 1 ? arrivalTolerance : 0.0001;
    if (distance <= tolerance) { out.index++; continue; }
    if (budget <= 0) break;
    const amount = Math.min(distance, budget), vx = dx / distance, vy = dy / distance;
    const next = move(out.x, out.y, out.x + vx * amount, out.y + vy * amount);
    const traveled = Math.hypot(next.x - out.x, next.y - out.y);
    out.x = next.x; out.y = next.y; out.traveled += traveled;
    if (traveled > 0) { out.vx = vx; out.vy = vy; }
    budget -= amount;
    if (Math.hypot(target.x - out.x, target.y - out.y) <= tolerance) out.index++;
    else break; // A collision cannot spend the remaining budget through another segment.
  }
  out.complete = out.index >= points.length;
  return out;
}
