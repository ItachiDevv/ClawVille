/**
 * Tiny pubsub for one-shot avatar emotes.
 *
 * The emote hotbar UI calls `fireEmote('flip')`; the player-avatar VRM
 * subscriber forwards the name to its VRMCharacterAnimator.playOneShot().
 *
 * Module-scope state — this is intentionally not in the Zustand game store
 * because emote firing is an event, not state. Storing it as state would
 * require a counter trick to detect "fired again" and would re-render
 * subscribers unnecessarily.
 *
 * Multiple listeners are supported (player VRM + future arena demo VRMs).
 * Listeners receive the same event; each decides whether to play it on
 * its own avatar.
 */

export type EmoteListener = (animationKey: string) => void;

const listeners = new Set<EmoteListener>();

export function subscribeEmote(listener: EmoteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function fireEmote(animationKey: string): void {
  for (const fn of listeners) {
    try {
      fn(animationKey);
    } catch (err) {
      console.error('[emote-bus] listener threw', err);
    }
  }
}
