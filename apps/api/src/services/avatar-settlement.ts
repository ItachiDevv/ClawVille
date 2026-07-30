export type AvatarSettlementResolution =
  | { status: 'ready'; address: string }
  | { status: 'pending' };

export type AvatarSettlementAddressFields =
  | { walletAddress: string; walletPending: false }
  | { walletPending: true };

export function resolveAvatarSettlementAddressFromCanonical(
  row: { publicKey: string; custodyVerified: boolean } | null | undefined,
): AvatarSettlementResolution {
  return row?.custodyVerified
    ? { status: 'ready', address: row.publicKey }
    : { status: 'pending' };
}

export function avatarSettlementAddressFields(
  resolution: AvatarSettlementResolution,
): AvatarSettlementAddressFields {
  return resolution.status === 'ready'
    ? { walletAddress: resolution.address, walletPending: false }
    : { walletPending: true };
}
