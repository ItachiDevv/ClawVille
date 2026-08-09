/**
 * Salvage topology + cap invariants.
 *
 * The clearance cases below are the point of this file: they RE-DERIVE every
 * node's distance from the live collider map and the live parcel supply rather
 * than asserting the numbers that were true on the day the layout was frozen.
 * That is what makes moving a building or re-tiering the land ring FAIL HERE,
 * instead of silently burying a salvage node inside a wall where no player can
 * ever reach it and no test would notice.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getServerColliders } from './world-colliders-data';
import { LAND_PARCELS } from './land-parcels';
import {
  SALVAGE_AVATAR_DAILY_CLAIM_CAP,
  SALVAGE_AVATAR_DAILY_MATERIAL_MAX,
  SALVAGE_LAYOUT_VERSION,
  SALVAGE_NODES,
  SALVAGE_NODE_COUNT,
  SALVAGE_OWNER_DAILY_CLAIM_CAP,
  SALVAGE_OWNER_DAILY_MATERIAL_MAX,
  SALVAGE_YIELD_MAX,
  SALVAGE_YIELD_MIN,
  getSalvageNode,
  isSalvageNodeId,
  salvageFlavourForYield,
} from './land-salvage';

const MAP_HALF = 11_264;
/**
 * An adult humanoid's collision half-width is 50 wu. Requiring 4x that means a
 * node is never merely "technically outside" a wall — a player can stand at it
 * and turn around.
 */
const MIN_CLEARANCE_WU = 200;

interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function clearance(x: number, z: number, b: Box): number {
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
  return Math.hypot(dx, dz);
}

const colliderBoxes: Box[] = getServerColliders().map((c) => ({
  minX: c.centerX - c.halfX,
  maxX: c.centerX + c.halfX,
  minZ: c.centerZ - c.halfZ,
  maxZ: c.centerZ + c.halfZ,
}));

const parcelBoxes: Box[] = LAND_PARCELS.map((p) => ({
  minX: p.cx - p.size / 2,
  maxX: p.cx + p.size / 2,
  minZ: p.cz - p.size / 2,
  maxZ: p.cz + p.size / 2,
}));

describe('SALVAGE_NODES — layout integrity', () => {
  it('has the designed node count', () => {
    expect(SALVAGE_NODE_COUNT).toBe(48);
    expect(SALVAGE_NODES).toHaveLength(48);
  });

  it('has unique ids, and every id resolves', () => {
    const ids = new Set(SALVAGE_NODES.map((n) => n.id));
    expect(ids.size).toBe(SALVAGE_NODES.length);
    for (const node of SALVAGE_NODES) {
      expect(getSalvageNode(node.id)).toEqual(node);
      expect(isSalvageNodeId(node.id)).toBe(true);
    }
    expect(getSalvageNode('not-a-node')).toBeNull();
    expect(isSalvageNodeId('not-a-node')).toBe(false);
  });

  it('spreads across all three bands', () => {
    const byBand = new Map<string, number>();
    for (const node of SALVAGE_NODES) {
      byBand.set(node.band, (byBand.get(node.band) ?? 0) + 1);
    }
    expect(byBand.get('shallows')).toBe(16);
    expect(byBand.get('shelf')).toBe(16);
    expect(byBand.get('deep')).toBe(16);
  });

  it('places every node inside the world bounds', () => {
    for (const node of SALVAGE_NODES) {
      expect(Math.abs(node.x)).toBeLessThan(MAP_HALF);
      expect(Math.abs(node.z)).toBeLessThan(MAP_HALF);
    }
  });

  // ── The two cases that catch a world change ───────────────────────────────

  it('clears every building collider by at least the standing margin', () => {
    for (const node of SALVAGE_NODES) {
      const nearest = Math.min(
        ...colliderBoxes.map((b) => clearance(node.x, node.z, b)),
      );
      // Named in the failure so a regression says WHICH node got buried.
      expect({ node: node.id, clearance: Math.round(nearest) }).toMatchObject({
        node: node.id,
      });
      expect(nearest).toBeGreaterThanOrEqual(MIN_CLEARANCE_WU);
    }
  });

  it('clears every land parcel footprint by at least the standing margin', () => {
    for (const node of SALVAGE_NODES) {
      const nearest = Math.min(
        ...parcelBoxes.map((b) => clearance(node.x, node.z, b)),
      );
      expect({ node: node.id, clearance: Math.round(nearest) }).toMatchObject({
        node: node.id,
      });
      expect(nearest).toBeGreaterThanOrEqual(MIN_CLEARANCE_WU);
    }
  });

  it('keeps nodes apart from each other, so one swim cannot reach two', () => {
    // 260 wu is the approach range; nodes closer than 2x that could both be in
    // range from one spot, which would let a single dwell serve two claims.
    for (let i = 0; i < SALVAGE_NODES.length; i++) {
      for (let j = i + 1; j < SALVAGE_NODES.length; j++) {
        const a = SALVAGE_NODES[i]!;
        const b = SALVAGE_NODES[j]!;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        expect({ pair: `${a.id}/${b.id}`, ok: d >= 520 }).toEqual({
          pair: `${a.id}/${b.id}`,
          ok: true,
        });
      }
    }
  });
});

describe('salvage caps', () => {
  it('derives the material ceilings from the claim caps', () => {
    expect(SALVAGE_AVATAR_DAILY_MATERIAL_MAX).toBe(
      SALVAGE_AVATAR_DAILY_CLAIM_CAP * SALVAGE_YIELD_MAX,
    );
    expect(SALVAGE_OWNER_DAILY_MATERIAL_MAX).toBe(
      SALVAGE_OWNER_DAILY_CLAIM_CAP * SALVAGE_YIELD_MAX,
    );
    // The founder's Q2 ruling, pinned: 120 admits six full-rate avatars.
    expect(SALVAGE_OWNER_DAILY_CLAIM_CAP / SALVAGE_AVATAR_DAILY_CLAIM_CAP).toBe(6);
  });

  /**
   * Migration 0056 hard-codes the caps in CHECK constraints. If a constant is
   * raised without a forward migration, every claim past the OLD bound fails as
   * a check violation instead of a clean 429 — a currency outage that looks
   * like a database fault. This case makes that a red test instead.
   */
  it('agrees with the CHECK constraints in migration 0056', () => {
    const ddl = readFileSync(
      join(import.meta.dir, '../../../database/migrations/0056_salvage_nodes.sql'),
      'utf8',
    );
    expect(ddl).toContain(
      `CHECK ("claims_admitted" BETWEEN 0 AND ${SALVAGE_AVATAR_DAILY_CLAIM_CAP})`,
    );
    expect(ddl).toContain(
      `CHECK ("materials_issued" BETWEEN 0 AND ${SALVAGE_AVATAR_DAILY_MATERIAL_MAX})`,
    );
    expect(ddl).toContain(
      `CHECK ("claims_admitted" BETWEEN 0 AND ${SALVAGE_OWNER_DAILY_CLAIM_CAP})`,
    );
  });
});

describe('salvageFlavourForYield', () => {
  it('is a total function over the yield band', () => {
    expect(salvageFlavourForYield(SALVAGE_YIELD_MIN)).toBe('common');
    expect(salvageFlavourForYield(2)).toBe('uncommon');
    expect(salvageFlavourForYield(SALVAGE_YIELD_MAX)).toBe('rare');
  });

  it('never emits a flavour the receipt CHECK would reject', () => {
    const allowed = new Set(['common', 'uncommon', 'rare']);
    for (let y = SALVAGE_YIELD_MIN; y <= SALVAGE_YIELD_MAX; y++) {
      expect(allowed.has(salvageFlavourForYield(y))).toBe(true);
    }
  });
});

describe('SALVAGE_LAYOUT_VERSION', () => {
  it('is a positive integer — it is a receipt fingerprint component', () => {
    expect(Number.isInteger(SALVAGE_LAYOUT_VERSION)).toBe(true);
    expect(SALVAGE_LAYOUT_VERSION).toBeGreaterThan(0);
  });
});
