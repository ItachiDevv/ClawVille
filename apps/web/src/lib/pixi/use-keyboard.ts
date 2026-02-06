import { useEffect, useRef, useCallback } from 'react';

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
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
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
