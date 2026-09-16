export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.right <= b.left ||
    a.left >= b.right ||
    a.bottom <= b.top ||
    a.top >= b.bottom
  );
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom
  );
}

export function sidebarRect(width: number, height: number): Rect {
  return {
    left: width - 16 - 224,
    right: width - 16,
    top: 56,
    bottom: height - 84,
  };
}

export function tapeRect(width: number, height: number): Rect {
  const sidebar = sidebarRect(width, height);
  const tapeHeight = Math.min(140, height * 0.2);
  return {
    left: sidebar.left,
    right: sidebar.right,
    top: sidebar.bottom - tapeHeight,
    bottom: sidebar.bottom,
  };
}

export function thoughtLogRect(
  width: number,
  height: number,
  minimized: boolean,
): Rect {
  const logHeight = minimized ? 32 : 260;
  return { left: 0, top: height - logHeight, right: width, bottom: height };
}

export function chatBarRect(width: number, height: number): Rect {
  const chatWidth = Math.min(512, width);
  return {
    left: (width - chatWidth) / 2,
    top: height - 72,
    right: (width + chatWidth) / 2,
    bottom: height,
  };
}

export function tapeVisibleForThoughtLog(
  thoughtLogOpen: boolean,
  thoughtLogMinimized: boolean,
): boolean {
  return !thoughtLogOpen || thoughtLogMinimized;
}
