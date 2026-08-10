import { afterEach, describe, expect, it } from "bun:test";
import { cashHouseSeeder, type BotSlot } from "../cash-house-seeder";

const SLOTS: BotSlot[] = [
  {
    index: 1,
    avatarId: "bot-a",
    agentId: "poker-bot-001",
    name: "Felt-Bot-001",
  },
  {
    index: 2,
    avatarId: "bot-b",
    agentId: "poker-bot-002",
    name: "Felt-Bot-002",
  },
];

afterEach(() => {
  cashHouseSeeder.__resetForTest();
});

describe('cash-house-seeder FIX-D restart reservation rehydration', () => {
  it("crash before commit: an uncommitted claim is absent after restart and the bot is reusable", () => {
    cashHouseSeeder.__resetForTest({ houseBankId: "bank", slots: SLOTS });
    expect(cashHouseSeeder.claim("table-old", 0)?.avatarId).toBe("bot-a");

    // Process dies before the seat transaction commits: no active DB row exists.
    cashHouseSeeder.__resetForTest({ houseBankId: "bank", slots: SLOTS });
    cashHouseSeeder.__rehydrateForTest([]);

    expect(cashHouseSeeder.reservedCount()).toBe(0);
    expect(cashHouseSeeder.claim("table-new", 0)?.avatarId).toBe("bot-a");
  });

  it("crash after commit + restart: the durable active seat is reserved before a new claim", () => {
    cashHouseSeeder.__resetForTest({ houseBankId: "bank", slots: SLOTS });
    expect(cashHouseSeeder.claim("table-live", 4)?.avatarId).toBe("bot-a");

    cashHouseSeeder.__resetForTest({ houseBankId: "bank", slots: SLOTS });
    cashHouseSeeder.__rehydrateForTest([{ tableId: "table-live", seatIndex: 4, avatarId: "bot-a" }]);

    expect(cashHouseSeeder.reservedCount()).toBe(1);
    expect(cashHouseSeeder.claim("table-live", 4)?.avatarId).toBe("bot-a");
    expect(cashHouseSeeder.claim("table-new", 0)?.avatarId).toBe("bot-b");
  });
});
