import { describe, expect, test } from 'bun:test';
import {
  activityCanvasDrawCalls,
  advanceActivityCanvasReady,
  type ActivityCanvasReadyState,
} from './ActivityCanvasReadyProbe';

function state(): ActivityCanvasReadyState {
  return { frames: 0, fired: false };
}

describe('ActivityCanvasReadyProbe', () => {
  test('registers a default-priority frame callback', async () => {
    const source = await Bun.file(
      `${import.meta.dir}/ActivityCanvasReadyProbe.tsx`,
    ).text();
    expect(source).toContain('useFrame(() => {');
    expect(source).not.toMatch(/useFrame\(\(\) => \{[\s\S]*?\},\s*[1-9]/);
  });

  test('observes a Bumper-shaped renderer draw call', () => {
    expect(
      activityCanvasDrawCalls({ info: { render: { calls: 3 } } }),
    ).toBeGreaterThan(0);
  });

  test('queues acknowledgement after a manual renderer callback', async () => {
    const order: string[] = [];
    const probe = state();
    advanceActivityCanvasReady(probe, () => {
      queueMicrotask(() => order.push('ack'));
    });
    order.push('manual-render');
    advanceActivityCanvasReady(probe, () => {
      queueMicrotask(() => order.push('ack'));
    });
    await Promise.resolve();
    expect(order).toEqual(['manual-render', 'ack']);
  });

  test('fires on the second frame, not the first', () => {
    const probe = state();
    let calls = 0;
    advanceActivityCanvasReady(probe, () => { calls += 1; });
    expect(calls).toBe(0);
    advanceActivityCanvasReady(probe, () => { calls += 1; });
    expect(calls).toBe(1);
  });

  test('fires exactly once across one hundred frames', () => {
    const probe = state();
    let calls = 0;
    for (let frame = 0; frame < 100; frame += 1) {
      advanceActivityCanvasReady(probe, () => { calls += 1; });
    }
    expect(calls).toBe(1);
  });

  test('scheduled acknowledgement reports its own room key', () => {
    const probe = state();
    const roomKey = 'reef-race:room-a';
    let reported: string | null = null;
    advanceActivityCanvasReady(probe, () => {});
    advanceActivityCanvasReady(probe, () => { reported = roomKey; });
    expect(reported).toBe(roomKey);
  });

  test('unmount before the second frame schedules nothing', () => {
    const probe = state();
    let calls = 0;
    advanceActivityCanvasReady(probe, () => { calls += 1; });
    expect({ calls, fired: probe.fired }).toEqual({
      calls: 0,
      fired: false,
    });
  });

  test('publishes the renderer canvas and clears the same handle', async () => {
    const source = await Bun.file(
      `${import.meta.dir}/ActivityCanvasReadyProbe.tsx`,
    ).text();
    expect(source).toContain('onCanvas(gl.domElement)');
    expect(source).toContain('return () => onCanvas(null)');
  });
});
