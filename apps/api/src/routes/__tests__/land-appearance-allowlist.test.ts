import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAND_TIERS,
  PALETTE_PRESETS,
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

function expectedShellAllowed(
  type: LandStructureType,
  level: number,
  tier: LandTier,
  shellKey: string,
): boolean {
  if (level < 1 || level > TIER_STRUCTURE_RULES[tier].maxLevel) return false;
  if (shellKey === "coastal-cottage") return true;
  if (shellKey === "driftwood-cabin" || shellKey === "fantasy-cottage")
    return level >= 2;
  return (
    shellKey === premiumKey(type) &&
    level >= 4 &&
    (tier === "b" || tier === "a" || tier === "founder")
  );
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
