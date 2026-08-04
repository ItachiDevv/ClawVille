export interface KelpActivationToken {
  readonly generation: number;
  readonly id: symbol;
}

export interface KelpActivationContext {
  readonly token: KelpActivationToken;
  readonly isCurrent: (token: KelpActivationToken) => boolean;
  readonly reportResetComplete: (
    token: KelpActivationToken,
    owner: 'beacon' | 'motion',
  ) => void;
  readonly owned: boolean;
}

export function createKelpActivationToken(
  generation: number,
): KelpActivationToken {
  return Object.freeze({
    generation,
    id: Symbol(`kelp-activation-${generation}`),
  });
}

export interface KelpActivationLifecycle {
  readonly context: KelpActivationContext;
  update(token: KelpActivationToken, owned: boolean): void;
  resetsComplete(token: KelpActivationToken): boolean;
}

export function createKelpActivationLifecycle(
  initialToken: KelpActivationToken,
  initialOwned: boolean,
  onResetsComplete?: (token: KelpActivationToken) => void,
): KelpActivationLifecycle {
  let liveToken = initialToken;
  let owned = initialOwned;
  let completedOwners = new Set<'beacon' | 'motion'>();

  const context: KelpActivationContext = {
    get token() {
      return liveToken;
    },
    get owned() {
      return owned;
    },
    isCurrent: (token) =>
      token.id === liveToken.id && owned,
    reportResetComplete: (token, owner) => {
      if (token.id !== liveToken.id) return;
      const sizeBefore = completedOwners.size;
      completedOwners.add(owner);
      if (
        sizeBefore !== completedOwners.size &&
        completedOwners.size === 2
      ) {
        onResetsComplete?.(token);
      }
    },
  };

  return {
    context,
    update: (token, nextOwned) => {
      if (token.id !== liveToken.id) {
        liveToken = token;
        completedOwners = new Set();
      }
      owned = nextOwned;
    },
    resetsComplete: (token) =>
      token.id === liveToken.id &&
      completedOwners.has('beacon') &&
      completedOwners.has('motion'),
  };
}
