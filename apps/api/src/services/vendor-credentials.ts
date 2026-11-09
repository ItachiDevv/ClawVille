/**
 * A human's own vendor API key (mode A, MCP hub step 2 phase 2b). With a key,
 * the vendor bills the human's own account and keeps the result there (Studios:
 * My Media). The key is encrypted at rest (keypair-vault `encryptToken`,
 * AES-256-GCM). Only the last 4 characters are ever returned. The key is sent
 * only to the vendor's own API host and is never logged.
 */

import { and, db, eq, userVendorCredentials } from '@clawville/database';
import { decryptToken, encryptToken } from './keypair-vault';
import { lockSpendRules } from './spend-policy';

/** Studios keys look like `chk_` + letters and digits. */
export const STUDIOS_KEY_PATTERN = /^chk_[A-Za-z0-9_-]{16,128}$/;

export interface VendorKeyStatus {
  linked: boolean;
  last4: string | null;
  updatedAt: string | null;
}

export async function readVendorKeyStatus(avatarId: string, vendor: string): Promise<VendorKeyStatus> {
  const row = await db.query.userVendorCredentials.findFirst({
    where: and(eq(userVendorCredentials.avatarId, avatarId), eq(userVendorCredentials.vendor, vendor)),
    columns: { last4: true, updatedAt: true },
  });
  return row
    ? { linked: true, last4: row.last4, updatedAt: new Date(row.updatedAt).toISOString() }
    : { linked: false, last4: null, updatedAt: null };
}

export async function saveVendorKey(avatarId: string, vendor: string, userId: string, key: string): Promise<VendorKeyStatus> {
  const sealed = encryptToken(key);
  const now = new Date();
  const values = { ...sealed, last4: key.slice(-4), updatedByUserId: userId, updatedAt: now };
  // The key decides who pays: written under the avatar's spend-rules lock.
  await db.transaction(async (tx) => {
    await lockSpendRules(tx, avatarId);
    await tx
      .insert(userVendorCredentials)
      .values({ avatarId, vendor, ...values })
      .onConflictDoUpdate({ target: [userVendorCredentials.avatarId, userVendorCredentials.vendor], set: values });
  });
  return { linked: true, last4: values.last4, updatedAt: now.toISOString() };
}

export async function deleteVendorKey(avatarId: string, vendor: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSpendRules(tx, avatarId);
    await tx
      .delete(userVendorCredentials)
      .where(and(eq(userVendorCredentials.avatarId, avatarId), eq(userVendorCredentials.vendor, vendor)));
  });
}

/** The decrypted key for one vendor call, or null. Never log the result. `executor`: a transaction that holds the spend-rules lock. */
export async function loadVendorKey(avatarId: string, vendor: string, executor: Pick<typeof db, 'select'> = db): Promise<string | null> {
  const [row] = await executor
    .select({ enc: userVendorCredentials.enc, iv: userVendorCredentials.iv, tag: userVendorCredentials.tag })
    .from(userVendorCredentials)
    .where(and(eq(userVendorCredentials.avatarId, avatarId), eq(userVendorCredentials.vendor, vendor)))
    .limit(1);
  if (!row) return null;
  return decryptToken(row.enc, row.iv, row.tag);
}
