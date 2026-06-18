import { useEffect, useRef, useCallback } from 'react';
import { registerInputReset } from '@/lib/three/input-reset';

interface KeyboardState {
  pressed: Set<string>;
  justPressed: Set<string>;
}

/**
 * Keyboard input hook for game controls.
 * Tracks pressed keys and one-shot events (E to enter, Escape to exit).
 */
export function useKeyboard() {
  const state = useRef<KeyboardState>({
    pressed: new Set(),
    justPressed: new Set(),
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't capture input when typing in text fields
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (!state.current.pressed.has(key)) {
        state.current.justPressed.add(key);
      }
      state.current.pressed.add(key);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      state.current.pressed.delete(key);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // S7 — clear held keys on window focus loss/regain (browser skips keyup when
    // focus leaves the window). Shared with the 3D input vectors via input-reset.ts.
    const unregisterReset = registerInputReset(() => {
      state.current.pressed.clear();
      state.current.justPressed.clear();
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      unregisterReset();
    };
  }, []);

  const isDown = useCallback((key: string) => {
    return state.current.pressed.has(key.toLowerCase());
  }, []);

  const wasJustPressed = useCallback((key: string) => {
    const k = key.toLowerCase();
    if (state.current.justPressed.has(k)) {
      state.current.justPressed.delete(k);
      return true;
    }
    return false;
  }, []);

  return { isDown, wasJustPressed };
}
