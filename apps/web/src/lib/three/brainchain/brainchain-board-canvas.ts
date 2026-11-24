import type { BoardText } from '@/components/brainchain/office-board-summary';

/** The DOM query layer owns every private read and amount format. */
export type BoardCanvasText = BoardText;

const INK = '#1d1d1d', ROSE = '#f386a1', IVORY = '#f8f7f4';
const MUTED = 'rgba(248,247,244,0.55)', FAINT = 'rgba(248,247,244,0.12)';
let logo: HTMLImageElement | undefined;
let logoLoaded = false;
let fontsReady: Promise<void> | undefined;
export function waitForBoardFonts(): Promise<void> {
  if (fontsReady) return fontsReady;
  fontsReady = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 1500);
    const finish = () => { clearTimeout(timer); resolve(); };
    const imageReady = new Promise<void>(done => {
      if (typeof Image === 'undefined') { done(); return; }
      logo = new Image();
      logo.onload = () => { logoLoaded = true; done(); };
      logo.onerror = () => { done(); };
      logo.src = '/brand/brainchain-mark-dot.svg';
    });
    try {
      const fonts = typeof document !== 'undefined' && document.fonts?.load
        ? ['44px "Fragment Mono"', '30px "Fragment Mono"', '26px "Fragment Mono"',
          '400 24px Geist', '500 21px Geist', '600 40px Geist', '700 32px Geist']
          .map(font => document.fonts.load(font)) : [];
      void Promise.allSettled([...fonts, imageReady]).then(finish, finish);
    } catch { void imageReady.then(finish, finish); }
  });
  return fontsReady;
}

export function clipBoardText(ctx: CanvasRenderingContext2D, value: string, width = 914): string {
  const text = value.replace(/[\r\n\t]/g, ' ');
  if (ctx.measureText(text).width <= width) return text;
  if (ctx.measureText('\u2026').width > width) return '';
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}\u2026`).width > width) end--;
  return `${text.slice(0, end)}\u2026`;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function spacing(ctx: CanvasRenderingContext2D, value: string): void {
  if ('letterSpacing' in ctx) ctx.letterSpacing = value;
}
function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number): void {
  ctx.fillText(clipBoardText(ctx, value, width), x, y);
}
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color = ROSE): void {
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, radius, 0, 7); ctx.fill();
}
function label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number): void {
  ctx.font = '600 17px Geist'; ctx.fillStyle = MUTED; spacing(ctx, '3px');
  text(ctx, value, x, y, width); spacing(ctx, '0px');
}
function pill(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, solid: boolean, width: number): number {
  ctx.font = '600 16px Geist'; spacing(ctx, '2px');
  const clipped = clipBoardText(ctx, value, width - 28);
  const w = ctx.measureText(clipped).width + 28;
  rounded(ctx, x, y, w, 30, 15);
  if (solid) { ctx.fillStyle = ROSE; ctx.fill(); ctx.fillStyle = INK; }
  else { ctx.lineWidth = 2; ctx.strokeStyle = ROSE; ctx.stroke(); ctx.fillStyle = ROSE; }
  ctx.fillText(clipped, x + 14, y + 21); spacing(ctx, '0px');
  return w;
}
function background(ctx: CanvasRenderingContext2D): void {
  ctx.textAlign = 'left'; spacing(ctx, '0px');
  ctx.fillStyle = '#0b0b0b'; ctx.fillRect(0, 0, 1024, 512);
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, INK); gradient.addColorStop(1, '#141414');
  rounded(ctx, 6, 6, 1012, 500, 28); ctx.fillStyle = gradient; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(243,134,161,0.55)'; ctx.stroke();
}
function frame(ctx: CanvasRenderingContext2D, board: BoardCanvasText): void {
  background(ctx);
  const logoWidth = 58 * 626 / 770, titleX = 44 + logoWidth + 22;
  if (logoLoaded && logo) ctx.drawImage(logo, 44, 30, logoWidth, 58);
  let titleRight = 976;
  if (board.updated !== null) {
    ctx.font = '500 21px Geist'; ctx.fillStyle = MUTED; ctx.textAlign = 'right';
    const chip = clipBoardText(ctx, `LIVE  ${board.updated}`, 260);
    ctx.fillText(chip, 976, 69);
    const chipLeft = 976 - ctx.measureText(chip).width;
    dot(ctx, chipLeft - 16, 62, 7); titleRight = chipLeft - 45;
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = IVORY; ctx.font = '44px "Fragment Mono"';
  text(ctx, board.title, titleX, 76, titleRight - titleX);
  ctx.fillStyle = FAINT; ctx.fillRect(44, 112, 936, 2);
}
function wrapped(ctx: CanvasRenderingContext2D, value: string, width: number, limit: number): string[] {
  const words = value.split(/\s+/), lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]!;
    if (line && ctx.measureText(next).width > width) {
      lines.push(clipBoardText(ctx, line, width)); line = words[i]!;
      if (lines.length === limit - 1) {
        lines.push(clipBoardText(ctx, words.slice(i).join(' '), width)); return lines;
      }
    } else line = next;
  }
  if (line) lines.push(clipBoardText(ctx, line, width));
  return lines;
}
function content(ctx: CanvasRenderingContext2D, board: BoardCanvasText): void {
  const view = board.view;
  if (view.kind === 'message') {
    ctx.textAlign = 'center'; ctx.fillStyle = view.tone === 'error' ? ROSE : IVORY;
    ctx.font = '600 40px Geist'; text(ctx, view.heading, 512, 250, 936);
    ctx.fillStyle = MUTED; ctx.font = '400 24px Geist';
    view.body.slice(0, 3).forEach((line, i) => text(ctx, line, 512, 298 + i * 36, 936));
    ctx.textAlign = 'left';
  } else {
    label(ctx, 'YOUR WORKER', 44, 158, 330);
    rounded(ctx, 44, 176, 330, 236, 20); ctx.fillStyle = '#262626'; ctx.fill();
    pill(ctx, view.worker.network, 66, 198, false, 286);
    ctx.fillStyle = IVORY; ctx.font = '30px "Fragment Mono"'; text(ctx, view.worker.address, 66, 272, 286);
    // Rose means the worker is running; paused or draining reads as inactive grey.
    dot(ctx, 74, 322, 8, view.worker.state === 'Running' ? ROSE : MUTED);
    ctx.fillStyle = IVORY; ctx.font = '600 26px Geist'; text(ctx, view.worker.state, 92, 331, 260);
    ctx.fillStyle = MUTED; ctx.font = '400 21px Geist'; text(ctx, view.worker.eligibility, 66, 374, 286);
    if (view.worker.more > 0) {
      ctx.font = '400 18px Geist';
      text(ctx, `+${view.worker.more} more worker${view.worker.more === 1 ? '' : 's'}`, 66, 438, 286);
    }
    label(ctx, 'TASKS', 414, 158, 566);
    if (view.emptyHeading) {
      ctx.fillStyle = IVORY; ctx.font = '600 28px Geist'; text(ctx, view.emptyHeading, 436, 250, 522);
      ctx.fillStyle = MUTED; ctx.font = '400 20px Geist';
      wrapped(ctx, view.emptyBody ?? '', 522, 3).forEach((line, i) => text(ctx, line, 436, 290 + i * 28, 522));
    } else view.rows.slice(0, 3).forEach((row, i) => {
      const y = 176 + i * 80;
      rounded(ctx, 414, y, 566, 68, 16); ctx.fillStyle = i === 0 ? '#2b2326' : '#232323'; ctx.fill();
      ctx.fillStyle = IVORY; ctx.font = '26px "Fragment Mono"'; text(ctx, row.id, 436, y + 32, 188);
      ctx.fillStyle = MUTED; ctx.font = '400 17px Geist'; text(ctx, row.detail, 436, y + 56, 188);
      const pillWidth = pill(ctx, row.status, 640, y + 19, row.highlight, 160);
      ctx.textAlign = 'right'; ctx.fillStyle = IVORY; ctx.font = '700 32px Geist';
      text(ctx, row.amount, 900, y + 45, 900 - (640 + pillWidth + 12));
      ctx.fillStyle = MUTED; ctx.font = '500 18px Geist'; text(ctx, row.unit, 960, y + 45, 56);
      ctx.textAlign = 'left';
    });
  }
  ctx.fillStyle = MUTED; ctx.font = '400 18px Geist'; text(ctx, board.footer, 44, 478, 936);
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
    frame(ctx, latest); content(ctx, latest);
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
