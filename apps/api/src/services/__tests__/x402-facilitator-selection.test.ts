import { describe, expect, it } from "bun:test";

import {
  MERIDIAN_OUTBOUND_CROSSOVER_USDC_ATOMIC,
  MERIDIAN_MIN_CREDITABLE_GROSS_USDC_ATOMIC,
  isMeridianEconomicalForOutbound,
  isFacilitatorOutageError,
  shouldFallbackToMeridian,
} from "../x402-facilitator-selection";
import {
  MERIDIAN_MAX_PLATFORM_FEE_BPS,
  assertSettlementAmountsConserved,
  calculateMeridianSettlementAmounts,
  legacySettlementAmounts,
} from "../x402-settlement-accounting";

describe("x402 facilitator selection", () => {
  it("keeps Meridian disabled as a strict no-op", () => {
    expect(
      shouldFallbackToMeridian({
        meridianEnabled: false,
        payAiOutage: true,
        direction: "inbound",
        grossUsdcAtomic: 1_000_000n,
      }),
    ).toBe(false);
  });

  it("never falls back for payment-invalid/non-outage failures", () => {
    expect(
      shouldFallbackToMeridian({
        meridianEnabled: true,
        payAiOutage: false,
        direction: "inbound",
        grossUsdcAtomic: 1_000_000n,
      }),
    ).toBe(false);
  });

  it("allows an inbound outage fallback independent of transaction size", () => {
    expect(
      shouldFallbackToMeridian({
        meridianEnabled: true,
        payAiOutage: true,
        direction: "inbound",
        grossUsdcAtomic: 100_000_000n,
      }),
    ).toBe(true);
  });

  it("applies the $0.10 outbound crossover at the exact boundary", () => {
    expect(
      isMeridianEconomicalForOutbound(
        MERIDIAN_OUTBOUND_CROSSOVER_USDC_ATOMIC - 1n,
      ),
    ).toBe(true);
    expect(
      isMeridianEconomicalForOutbound(
        MERIDIAN_OUTBOUND_CROSSOVER_USDC_ATOMIC,
      ),
    ).toBe(true);
    expect(
      isMeridianEconomicalForOutbound(
        MERIDIAN_OUTBOUND_CROSSOVER_USDC_ATOMIC + 1n,
      ),
    ).toBe(false);
  });

  it("rejects zero and negative outbound amounts", () => {
    expect(isMeridianEconomicalForOutbound(0n)).toBe(false);
    expect(isMeridianEconomicalForOutbound(-1n)).toBe(false);
  });

  it("does not select Meridian when a one-cent gross would net zero vCLAW", () => {
    expect(isMeridianEconomicalForOutbound(10_000n)).toBe(false);
    expect(
      isMeridianEconomicalForOutbound(
        MERIDIAN_MIN_CREDITABLE_GROSS_USDC_ATOMIC,
      ),
    ).toBe(true);
  });

  it("classifies only structured transport/timeout/5xx failures as outages", () => {
    expect(isFacilitatorOutageError({ status: 500 })).toBe(true);
    expect(isFacilitatorOutageError({ status: 503 })).toBe(true);
    expect(isFacilitatorOutageError({ status: 400 })).toBe(false);
    expect(isFacilitatorOutageError({ status: 429 })).toBe(false);
    expect(
      isFacilitatorOutageError(
        new Error('Facilitator verify failed (500): upstream failed'),
      ),
    ).toBe(true);
    expect(
      isFacilitatorOutageError(
        new Error('Facilitator verify failed (400): payment invalid'),
      ),
    ).toBe(false);
    expect(isFacilitatorOutageError(new TypeError("fetch failed"))).toBe(true);
    expect(isFacilitatorOutageError({ name: "TimeoutError" })).toBe(true);
    expect(isFacilitatorOutageError({ name: "AbortError" })).toBe(true);
    expect(isFacilitatorOutageError(new Error("invalid payment"))).toBe(false);
    expect(isFacilitatorOutageError("Facilitator verify failed (500)"))
      .toBe(false);
  });
});

describe("x402 Meridian settlement accounting", () => {
  it.each([0, 1, 250, 999, MERIDIAN_MAX_PLATFORM_FEE_BPS])(
    "conserves gross at %d platform basis points",
    (platformFeeBps) => {
      const amounts = calculateMeridianSettlementAmounts(
        12_345_678n,
        platformFeeBps,
      );

      expect(() => assertSettlementAmountsConserved(amounts)).not.toThrow();
      expect(amounts.grossUsdcAtomic).toBe(
        amounts.netUsdcAtomic +
          amounts.platformFeeUsdcAtomic +
          amounts.treasuryFeeUsdcAtomic,
      );
    },
  );

  it("uses zero platform fee while retaining Meridian's 100 bps treasury fee", () => {
    expect(calculateMeridianSettlementAmounts(1_000_000n, 0)).toEqual({
      grossUsdcAtomic: 1_000_000n,
      platformFeeUsdcAtomic: 0n,
      treasuryFeeUsdcAtomic: 10_000n,
      netUsdcAtomic: 990_000n,
    });
  });

  it("uses the captured 1000 bps platform cap", () => {
    expect(
      calculateMeridianSettlementAmounts(
        1_000_000n,
        MERIDIAN_MAX_PLATFORM_FEE_BPS,
      ),
    ).toEqual({
      grossUsdcAtomic: 1_000_000n,
      platformFeeUsdcAtomic: 100_000n,
      treasuryFeeUsdcAtomic: 9_000n,
      netUsdcAtomic: 891_000n,
    });
    expect(() =>
      calculateMeridianSettlementAmounts(
        1_000_000n,
        MERIDIAN_MAX_PLATFORM_FEE_BPS + 1,
      ),
    ).toThrow();
  });

  it("preserves legacy PayAI receipt semantics", () => {
    expect(legacySettlementAmounts(250_000n)).toEqual({
      grossUsdcAtomic: 250_000n,
      platformFeeUsdcAtomic: 0n,
      treasuryFeeUsdcAtomic: 0n,
      netUsdcAtomic: 250_000n,
    });
  });
});
