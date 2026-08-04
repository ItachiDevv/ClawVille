import {
  avatarSettlementAddressFields,
  type AvatarSettlementResolution,
} from './avatar-settlement';

export function mergeHatcherStatsSettlement(
  body: Record<string, unknown>,
  settlement: AvatarSettlementResolution,
): Record<string, unknown> {
  const registration = {
    ...((body.registration as Record<string, unknown> | undefined) ?? {}),
  };
  delete registration.walletAddress;
  delete registration.walletPending;
  return {
    ...body,
    registration: {
      ...registration,
      ...avatarSettlementAddressFields(settlement),
    },
  };
}
