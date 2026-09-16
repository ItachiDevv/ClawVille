import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  chatBarRect,
  rectContains,
  rectsOverlap,
  sidebarRect,
  tapeRect,
  tapeVisibleForThoughtLog,
  thoughtLogRect,
} from './placement';

const viewports = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
] as const;

describe('Trading Floor tape placement', () => {
  test.each(viewports)('keeps the full tape inside the sidebar at %ix%i', (width, height) => {
    expect(rectContains(sidebarRect(width, height), tapeRect(width, height))).toBe(true);
  });

  test.each(viewports)('separates minimized log and chat rectangles at %ix%i', (width, height) => {
    const tape = tapeRect(width, height);
    expect(rectsOverlap(tape, thoughtLogRect(width, height, true))).toBe(false);
    expect(rectsOverlap(tape, chatBarRect(width, height))).toBe(false);
    expect(tapeVisibleForThoughtLog(true, true)).toBe(true);
  });

  test.each(viewports)('suppresses the tape for an expanded thought log at %ix%i', (width, height) => {
    expect(rectsOverlap(tapeRect(width, height), thoughtLogRect(width, height, false))).toBe(true);
    expect(tapeVisibleForThoughtLog(true, false)).toBe(false);
  });

  test('uses the existing thought-log state and no layout store', () => {
    const source = readFileSync(new URL('./floor-tape.tsx', import.meta.url), 'utf8');
    expect(source).toContain('state.thoughtLogOpen');
    expect(source).toContain('state.thoughtLogMinimized');
    expect(source).not.toContain('layoutStore');
  });

  test('leaves a positive sidebar scroll region at 720p', () => {
    const sidebar = sidebarRect(1280, 720);
    const tape = tapeRect(1280, 720);
    expect((sidebar.bottom - sidebar.top) - (tape.bottom - tape.top)).toBeGreaterThan(0);
  });

  test('keeps fixed positioning and z-index out of the tape source', () => {
    const source = readFileSync(new URL('./floor-tape.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/position:\s*['"]fixed['"]/);
    expect(source).not.toMatch(/zIndex|z-index/);
  });
});
