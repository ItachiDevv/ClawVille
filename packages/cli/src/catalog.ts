/**
 * The catalog the CLI uses. It is the reviewed `ECOSYSTEM_CATALOG` from
 * `@clawville/shared`, bundled into the published file at build time. The CLI
 * never fetches a catalog or a command from the network.
 */
import {
  ECOSYSTEM_CATALOG,
  ECOSYSTEM_GENERAL_NOTES,
  servedEcosystemCatalog,
  type EcosystemCatalogEntry,
} from '@clawville/shared/ecosystem-catalog';

export type { EcosystemCatalogEntry };
export { ECOSYSTEM_GENERAL_NOTES };

/** The served (`available`) rows, resolved for `apiBase`. */
export function catalogRows(apiBase: string): EcosystemCatalogEntry[] {
  return servedEcosystemCatalog(apiBase);
}

/** True when the id exists in the catalog but is not served (`planned`). */
export function isPlannedRow(id: string): boolean {
  return ECOSYSTEM_CATALOG.some((entry) => entry.id === id && entry.status !== 'available');
}

/** The ClawVille MCP tools that a gateway row names in its summary (for example `clawville_market`). */
export function gatewayTools(row: EcosystemCatalogEntry): string[] {
  return [...new Set(row.summary.match(/\bclawville_[a-z_]+\b/g) ?? [])];
}
