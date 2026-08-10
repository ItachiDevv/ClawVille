import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAND_TIERS,
  PALETTE_PRESETS,
  PREMIUM_SHELL_TIERS,
  SHELL_CATALOG,
  TIER_STRUCTURE_RULES,
  isPaletteAllowed,
  isShellAllowed,
  isSkuAllowedForTier,
  type LandStructureType,
  type LandTier,
} from "@clawville/shared";

const TYPES: readonly LandStructureType[] = ["home", "shop"];
const LEVEL_BOUNDARIES = [0, 1, 2, 3, 4, 5, 6] as const;
const SHELL_KEYS = [
  ...new Set(SHELL_CATALOG.map((entry) => entry.key)),
  "not-a-shell",
] as const;

const premiumKey = (type: LandStructureType): string =>
  type === "home" ? "premium-tower" : "premium-mall";

/**
 * Independent re-implementation of the shell gate.
 *
 * This used to hardcode the roster ("coastal-cottage always, driftwood/fantasy
 * from Lv2, otherwise premium"), which made every catalog addition a test
 * failure and tempted the fix of just appending more key names. It now reads
 * `minLevel` and `premium` off the catalog row and re-derives the RULE from
 * them, because the rule is what this test exists to pin — the roster is data.
 * It still never calls `isShellAllowed`, so a bug in the real gate cannot hide.
 */
function expectedShellAllowed(
  type: LandStructureType,
  level: number,
  tier: LandTier,
  shellKey: string,
): boolean {
  if (level < 1 || level > TIER_STRUCTURE_RULES[tier].maxLevel) return false;
  const entry = SHELL_CATALOG.find(
    (row) => row.structureType === type && row.key === shellKey,
  );
  if (!entry) return false;
  if (level < entry.minLevel) return false;
  if (!entry.premium) return true;
  return tier === "b" || tier === "a" || tier === "founder";
}

describe("land appearance allowlists", () => {
  it("matches the full type × level × tier × shell boundary matrix", () => {
    for (const type of TYPES) {
      for (const level of LEVEL_BOUNDARIES) {
        for (const tier of LAND_TIERS) {
          for (const shellKey of SHELL_KEYS) {
            expect(
              isShellAllowed(type, level, tier, shellKey),
              `${type} Lv${level} ${tier} ${shellKey}`,
            ).toBe(expectedShellAllowed(type, level, tier, shellKey));
          }
        }
      }
    }
  });

  it("keeps D2 capacity-only: starter/c never unlock premium or founder shells", () => {
    expect(TIER_STRUCTURE_RULES.starter.maxLevel).toBe(3);
    expect(TIER_STRUCTURE_RULES.c.maxLevel).toBe(4);
    for (const type of TYPES) {
      for (const tier of ["starter", "c"] as const) {
        for (const level of LEVEL_BOUNDARIES) {
          expect(isShellAllowed(type, level, tier, premiumKey(type))).toBe(
            false,
          );
          expect(
            isShellAllowed(type, level, tier, `${type}-founder-shell`),
          ).toBe(false);
        }
      }
    }
  });

  it("exposes exactly three palettes at Lv1 and all eight from Lv2", () => {
    expect(PALETTE_PRESETS).toHaveLength(8);
    expect(
      PALETTE_PRESETS.filter((preset) => isPaletteAllowed(1, preset.key)),
    ).toHaveLength(3);
    for (const level of [2, 3, 4, 5]) {
      expect(
        PALETTE_PRESETS.filter((preset) => isPaletteAllowed(level, preset.key)),
      ).toHaveLength(8);
    }
    expect(isPaletteAllowed(0, "classic")).toBe(false);
    expect(isPaletteAllowed(6, "classic")).toBe(false);
    expect(isPaletteAllowed(2, "not-a-palette")).toBe(false);
  });

  it("pins the home shell roster and its founder-tunable unlock levels", () => {
    const homes = SHELL_CATALOG.filter((entry) => entry.structureType === "home");
    expect(
      homes.map((entry) => [entry.key, entry.minLevel, entry.premium]),
    ).toEqual([
      ["coastal-cottage", 1, false],
      ["driftwood-cabin", 2, false],
      ["fantasy-cottage", 2, false],
      ["pearl-dome", 1, false],
      ["tiki-hut", 2, false],
      ["anchor-forge", 2, false],
      ["shipwreck-mast", 2, false],
      ["tide-lighthouse", 3, false],
      ["kelp-spire", 3, false],
      ["coral-highrise", 3, false],
      ["premium-tower", 4, true],
    ]);
    // Every tier can reach Lv3, so the whole non-premium roster is reachable
    // on a starter parcel. Premium stays the only tier-gated shell.
    for (const entry of homes.filter((row) => !row.premium)) {
      expect(
        isShellAllowed("home", entry.minLevel, "starter", entry.key),
        entry.key,
      ).toBe(true);
    }
  });

  it("points every catalog row at a GLB that actually exists on disk", () => {
    // A catalog row naming a missing asset is a runtime 404 and a shell that
    // silently falls back to the default, which is invisible in every other
    // test here because they only ever exercise the allowlist logic.
    for (const entry of SHELL_CATALOG) {
      const absolute = join(
        import.meta.dir,
        "../../../../../apps/web/public",
        entry.modelPath,
      );
      expect(existsSync(absolute), `${entry.structureType}/${entry.key} -> ${entry.modelPath}`)
        .toBe(true);
    }
  });

  it("keeps classic as an identity tint and names the premium shell tiers", () => {
    expect(PALETTE_PRESETS.find((preset) => preset.key === "classic")?.swatches)
      .toEqual(["#FFFFFF", "#FFFFFF", "#FFFFFF"]);
    expect(PREMIUM_SHELL_TIERS).toEqual(["b", "a", "founder"]);
  });
});

describe("D2 SKU independence guard", () => {
  const expectedSkus: Record<
    LandTier,
    Record<LandStructureType, readonly string[]>
  > = {
    starter: {
      home: ["home-shack", "home-cottage"],
      shop: ["shop-stall", "shop-shopfront"],
    },
    c: {
      home: ["home-shack", "home-cottage", "home-house"],
      shop: ["shop-stall", "shop-shopfront", "shop-market"],
    },
    b: {
      home: ["home-shack", "home-cottage", "home-house", "home-villa"],
      shop: ["shop-stall", "shop-shopfront", "shop-market", "shop-emporium"],
    },
    a: {
      home: [
        "home-shack",
        "home-cottage",
        "home-house",
        "home-villa",
        "home-mansion",
      ],
      shop: [
        "shop-stall",
        "shop-shopfront",
        "shop-market",
        "shop-emporium",
        "shop-grand-bazaar",
      ],
    },
    founder: {
      home: [
        "home-shack",
        "home-cottage",
        "home-house",
        "home-villa",
        "home-mansion",
        "home-founders-estate",
      ],
      shop: [
        "shop-stall",
        "shop-shopfront",
        "shop-market",
        "shop-emporium",
        "shop-grand-bazaar",
        "shop-founders-exchange",
      ],
    },
  };

  it("does not change any isSkuAllowedForTier result", () => {
    const allSkus = [
      ...new Set(
        Object.values(expectedSkus).flatMap((byType) => [
          ...byType.home,
          ...byType.shop,
        ]),
      ),
      "not-a-sku",
    ];
    for (const tier of LAND_TIERS) {
      for (const type of TYPES) {
        for (const sku of allSkus) {
          expect(
            isSkuAllowedForTier(sku, type, tier),
            `${tier} ${type} ${sku}`,
          ).toBe(expectedSkus[tier][type].includes(sku));
        }
      }
    }
  });
});

describe("0048 appearance migration", () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "packages",
      "database",
      "migrations",
      "0048_land_structure_appearance.sql",
    ),
    "utf8",
  );

  it("is additive/idempotent and deterministically backfills both defaults", () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "shell_key" text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "palette_key" text');
    expect(sql).toMatch(
      /SET "shell_key" = 'coastal-cottage'\s+WHERE "shell_key" IS NULL/,
    );
    expect(sql).toMatch(
      /SET "palette_key" = 'classic'\s+WHERE "palette_key" IS NULL/,
    );
    expect(sql).toContain("-- FOLLOW-UP:");
    expect(sql).not.toMatch(/SET\s+NOT\s+NULL/i);
  });
});
