import { describe, expect, test } from 'bun:test';
import {
  getHudElement,
  registerHudElement,
  subscribeHudElement,
} from '../hud-anchors';

// The registry only stores references, so plain objects stand in for elements.
const el = (name: string) => ({ name }) as unknown as HTMLElement;

// Each test uses its own attr so module state never leaks between tests.
describe('HUD element registry', () => {
  test('register makes the element readable and notifies subscribers', () => {
    const attr = 'test-register';
    const a = el('a');
    let calls = 0;
    const unsubscribe = subscribeHudElement(attr, () => { calls++; });
    const cleanup = registerHudElement(attr, a);
    expect(getHudElement(attr)).toBe(a);
    expect(calls).toBe(1);
    cleanup();
    expect(getHudElement(attr)).toBeNull();
    expect(calls).toBe(2);
    unsubscribe();
  });

  test('a late subscriber reads an element that registered first', () => {
    const attr = 'test-late';
    const a = el('a');
    const cleanup = registerHudElement(attr, a);
    // The reader mounts after the owner: it must still find it by reading.
    expect(getHudElement(attr)).toBe(a);
    cleanup();
  });

  test('unsubscribe stops notifications', () => {
    const attr = 'test-unsub';
    let calls = 0;
    const unsubscribe = subscribeHudElement(attr, () => { calls++; });
    unsubscribe();
    const cleanup = registerHudElement(attr, el('a'));
    cleanup();
    expect(calls).toBe(0);
  });

  test('a stale owner can never clear a newer registration', () => {
    // A registers, B registers (last wins), then A unmounts: B must survive.
    // Before ownership-aware cleanup, A's unmount deleted B (Codex review, 2026-09-18).
    const attr = 'test-two-owners';
    const a = el('a');
    const b = el('b');
    const cleanupA = registerHudElement(attr, a);
    const cleanupB = registerHudElement(attr, b);
    expect(getHudElement(attr)).toBe(b);
    cleanupA();
    expect(getHudElement(attr)).toBe(b);
    cleanupB();
    expect(getHudElement(attr)).toBeNull();
  });

  test('a remount replaces the old element and notifies again', () => {
    const attr = 'test-remount';
    const first = el('first');
    const second = el('second');
    const seen: Array<HTMLElement | null> = [];
    const unsubscribe = subscribeHudElement(attr, () => { seen.push(getHudElement(attr)); });
    const cleanupFirst = registerHudElement(attr, first);
    cleanupFirst();
    const cleanupSecond = registerHudElement(attr, second);
    expect(seen).toEqual([first, null, second]);
    cleanupSecond();
    unsubscribe();
  });
});
