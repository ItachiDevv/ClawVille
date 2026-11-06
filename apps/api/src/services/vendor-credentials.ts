/**
 * A human's own vendor API key (mode A, MCP hub step 2 phase 2b). With a key,
 * the vendor bills the human's own account and keeps the result there (Studios:
 * My Media). The key is encrypted at rest (keypair-vault `encryptToken`,
 * AES-256-GCM). Only the last 4 characters are ever returned. The key is sent
 * only to the vendor's own API host and is never logged.
 *
 * Since migration 0094 the table also holds sign-in rows (kind 'oauth',
 * services/vendors/studios-oauth.ts). Every helper here reads and writes only
 * kind 'api_key' rows, so a sign-in never shows as a key and removing the key
 * never removes the sign-in.
 */

import { and, db, eq, userVendorCredentials } from '@clawville/database';
import { decryptToken, encryptToken } from './keypair-vault';

const API_KEY_KIND = 'api_key';

function keyRow(avatarId: string, vendor: string) {
  return and(
    eq(userVendorCredentials.avatarId, avatarId),
    eq(userVendorCredentials.vendor, vendor),
    eq(userVendorCredentials.kind, API_KEY_KIND),
  );
}

/** Studios keys look like `chk_` + letters and digits. */
export const STUDIOS_KEY_PATTERN = /^chk_[A-Za-z0-9_-]{16,128}$/;

export interface VendorKeyStatus {
  linked: boolean;
  last4: string | null;
  updatedAt: string | null;
}

export async function readVendorKeyStatus(avatarId: string, vendor: string): Promise<VendorKeyStatus> {
  const row = await db.query.userVendorCredentials.findFirst({
    where: keyRow(avatarId, vendor),
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
  await db
    .insert(userVendorCredentials)
    .values({ avatarId, vendor, kind: API_KEY_KIND, ...values })
    .onConflictDoUpdate({
      target: [userVendorCredentials.avatarId, userVendorCredentials.vendor, userVendorCredentials.kind],
      set: values,
    });
  return { linked: true, last4: values.last4, updatedAt: now.toISOString() };
}

export async function deleteVendorKey(avatarId: string, vendor: string): Promise<void> {
  await db
    .delete(userVendorCredentials)
    .where(keyRow(avatarId, vendor));
}

/** The decrypted key for one vendor call, or null. Never log the result. */
export async function loadVendorKey(avatarId: string, vendor: string): Promise<string | null> {
  const row = await db.query.userVendorCredentials.findFirst({
    where: keyRow(avatarId, vendor),
    columns: { enc: true, iv: true, tag: true },
  });
  if (!row || !row.enc || !row.iv || !row.tag) return null;
  return decryptToken(row.enc, row.iv, row.tag);
}
