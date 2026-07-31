export type AvatarWalletMatrixBranch =
  | 'canonical-valid-mirror-equal'
  | 'canonical-valid-mirror-null'
  | 'canonical-valid-mirror-mismatch'
  | 'canonical-absent-mirror-null'
  | 'canonical-absent-mirror-present'
  | 'canonical-invalid';

export interface CanonicalAvatarWallet {
  id: string;
  publicKey: string;
  custodyVerified: boolean;
}

export interface AvatarWalletSnapshot {
  avatarExists: boolean;
  mirrorAddress: string | null;
  canonical: CanonicalAvatarWallet | null;
}

export interface CreatedCanonicalAvatarWallet {
  canonical: CanonicalAvatarWallet;
  inserted: boolean;
  firstTimeSecretKeyBase58?: string;
}

export interface AvatarWalletReconciliationAdapter {
  loadSnapshot(): Promise<AvatarWalletSnapshot>;
  validateCanonical(canonical: CanonicalAvatarWallet): Promise<boolean>;
  createValidatedCanonical(disclose: boolean): Promise<CreatedCanonicalAvatarWallet>;
  setCustodyVerified(walletId: string, verified: boolean): Promise<void>;
  /**
   * The only allowed mirror write. Implementations must update only when the
   * mirror is NULL, then return the observed post-write state.
   */
  fillMirrorIfNull(address: string): Promise<'equal' | 'mismatch' | 'missing'>;
  trackException(branch: AvatarWalletMatrixBranch, detail: string): void;
}

export interface AvatarWalletReconciliationResult {
  status: 'ready' | 'pending';
  branch: AvatarWalletMatrixBranch;
  address?: string;
  inserted: boolean;
  firstTimeSecretKeyBase58?: string;
}

export function classifyAvatarWalletMatrix(
  snapshot: AvatarWalletSnapshot,
  canonicalValid: boolean | null,
): AvatarWalletMatrixBranch {
  if (!snapshot.canonical) {
    return snapshot.mirrorAddress === null
      ? 'canonical-absent-mirror-null'
      : 'canonical-absent-mirror-present';
  }
  if (canonicalValid !== true) return 'canonical-invalid';
  if (snapshot.mirrorAddress === null) return 'canonical-valid-mirror-null';
  return snapshot.mirrorAddress === snapshot.canonical.publicKey
    ? 'canonical-valid-mirror-equal'
    : 'canonical-valid-mirror-mismatch';
}

function pending(
  branch: AvatarWalletMatrixBranch,
  inserted = false,
): AvatarWalletReconciliationResult {
  return { status: 'pending', branch, inserted };
}

/**
 * Apply the frozen five-way canonical/avatar-mirror promotion matrix.
 *
 * The adapter owns encryption and persistence details. This dependency-light
 * coordinator owns the safety ordering and never exposes an operation capable
 * of replacing a non-null mirror.
 */
export async function reconcileAvatarWallet(
  adapter: AvatarWalletReconciliationAdapter,
  options: { apply: boolean; disclose: boolean },
): Promise<AvatarWalletReconciliationResult> {
  let snapshot = await adapter.loadSnapshot();
  if (!snapshot.avatarExists) {
    adapter.trackException('canonical-invalid', 'avatar row is missing');
    return pending('canonical-invalid');
  }

  let canonicalValid: boolean | null = null;
  if (snapshot.canonical) {
    try {
      canonicalValid = await adapter.validateCanonical(snapshot.canonical);
    } catch {
      canonicalValid = false;
    }
  }

  let branch = classifyAvatarWalletMatrix(snapshot, canonicalValid);
  if (!options.apply) {
    return {
      status:
        branch === 'canonical-valid-mirror-equal' && snapshot.canonical?.custodyVerified
          ? 'ready'
          : 'pending',
      branch,
      address: snapshot.canonical?.publicKey,
      inserted: false,
    };
  }

  if (branch === 'canonical-invalid') {
    if (snapshot.canonical) {
      await adapter.setCustodyVerified(snapshot.canonical.id, false);
    }
    adapter.trackException(branch, 'canonical wallet failed decrypt/public-key validation');
    return pending(branch);
  }

  if (branch === 'canonical-valid-mirror-mismatch') {
    await adapter.setCustodyVerified(snapshot.canonical!.id, false);
    adapter.trackException(
      branch,
      `canonical ${snapshot.canonical!.publicKey} differs from non-null avatar mirror`,
    );
    return pending(branch);
  }

  if (branch === 'canonical-absent-mirror-present') {
    adapter.trackException(branch, 'non-null avatar mirror has no canonical wallet row');
    return pending(branch);
  }

  if (branch === 'canonical-valid-mirror-null') {
    const mirrorState = await adapter.fillMirrorIfNull(snapshot.canonical!.publicKey);
    if (mirrorState !== 'equal') {
      await adapter.setCustodyVerified(snapshot.canonical!.id, false);
      adapter.trackException(
        'canonical-valid-mirror-mismatch',
        'avatar mirror changed while NULL-only repair was in flight',
      );
      return pending('canonical-valid-mirror-mismatch');
    }
    await adapter.setCustodyVerified(snapshot.canonical!.id, true);
    return {
      status: 'ready',
      branch,
      address: snapshot.canonical!.publicKey,
      inserted: false,
    };
  }

  if (branch === 'canonical-valid-mirror-equal') {
    await adapter.setCustodyVerified(snapshot.canonical!.id, true);
    return {
      status: 'ready',
      branch,
      address: snapshot.canonical!.publicKey,
      inserted: false,
    };
  }

  const created = await adapter.createValidatedCanonical(options.disclose);
  if (!created.inserted) {
    // A concurrent process won the UNIQUE(subject_type, subject_id) race.
    // Re-read and reconcile the winner. The losing call never discloses.
    return reconcileAvatarWallet(adapter, { apply: true, disclose: false });
  }

  const mirrorState = await adapter.fillMirrorIfNull(created.canonical.publicKey);
  if (mirrorState !== 'equal') {
    await adapter.setCustodyVerified(created.canonical.id, false);
    adapter.trackException(
      'canonical-valid-mirror-mismatch',
      'avatar mirror changed while the canonical insert winner repaired NULL',
    );
    return pending('canonical-valid-mirror-mismatch', true);
  }

  return {
    status: 'ready',
    branch,
    address: created.canonical.publicKey,
    inserted: true,
    ...(created.firstTimeSecretKeyBase58
      ? { firstTimeSecretKeyBase58: created.firstTimeSecretKeyBase58 }
      : {}),
  };
}
