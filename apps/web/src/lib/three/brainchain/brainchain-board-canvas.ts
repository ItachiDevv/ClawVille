/** Plain text only: the DOM query layer owns every private read and amount format. */
export interface BoardCanvasText {
  title: string;
  lines: string[];
  footer: string;
}

let fontsReady: Promise<void> | undefined;
export function waitForBoardFonts(): Promise<void> {
  if (fontsReady) return fontsReady;
  if (typeof document === 'undefined' || !document.fonts?.load) return Promise.resolve();
  fontsReady = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 1500);
    const finish = () => { clearTimeout(timer); resolve(); };
    try {
      void Promise.all([
        document.fonts.load('52px "Fragment Mono"'),
        document.fonts.load('28px Geist'),
      ]).then(finish, finish);
    } catch { finish(); }
  });
  return fontsReady;
}

export function clipBoardText(ctx: CanvasRenderingContext2D, value: string, width = 914): string {
  const text = value.replace(/[\r\n\t]/g, ' ');
  if (ctx.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > width) end--;
  return `${text.slice(0, end)}…`;
}

function background(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#1d1d1d'; ctx.fillRect(0, 0, 1024, 512);
  ctx.strokeStyle = '#f386a1'; ctx.lineWidth = 8; ctx.strokeRect(8, 8, 1008, 496);
}

/** One controller per retained canvas. No timers or allocations occur in the frame loop. */
export function createBoardCanvasWriter(
  ctx: CanvasRenderingContext2D | null,
  invalidate: () => void,
  fontWait: Promise<void>,
) {
  let ready = false;
  let key = '';
  let owner: string | null | undefined;
  let latest: BoardCanvasText | undefined;
  function draw(): void {
    if (!ctx || !latest) return;
    background(ctx);
    ctx.fillStyle = '#f8f7f4'; ctx.font = '52px "Fragment Mono", monospace';
    ctx.fillText(clipBoardText(ctx, latest.title), 55, 70);
    ctx.font = '28px Geist, sans-serif';
    latest.lines.slice(0, 12).forEach((line, index) => {
      const text = index === 11 && latest!.lines.length > 12 ? `${line}…` : line;
      ctx.fillText(clipBoardText(ctx, text), 55, 112 + index * 30);
    });
    ctx.fillStyle = '#f386a1';
    ctx.fillText(clipBoardText(ctx, latest.footer), 55, 480);
    invalidate();
  }
  void fontWait.then(() => { ready = true; draw(); });
  return {
    update(ownerId: string | null, text: BoardCanvasText): boolean {
      const nextKey = JSON.stringify([ownerId, text]);
      if (nextKey === key) return false;
      key = nextKey; latest = text;
      // Privacy takes priority over the font wait. Erase the old owner's pixels now.
      if (owner !== ownerId && !ready && ctx) { background(ctx); invalidate(); }
      owner = ownerId;
      if (ready) draw();
      return true;
    },
  };
}
