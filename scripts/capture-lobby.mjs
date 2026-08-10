import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3117";
const chromePath =
  process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const outputDir = path.resolve(import.meta.dirname);

const tables = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    source: "house",
    tierKey: "high",
    buyInCt: "500",
    smallBlindCt: "25",
    bigBlindCt: "50",
    maxSeats: 6,
    occupiedSeats: 5,
    status: "playing",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    source: "house",
    tierKey: "mid",
    buyInCt: "100",
    smallBlindCt: "5",
    bigBlindCt: "10",
    maxSeats: 6,
    occupiedSeats: 3,
    status: "open",
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    source: "house",
    tierKey: "low",
    buyInCt: "20",
    smallBlindCt: "1",
    bigBlindCt: "2",
    maxSeats: 6,
    occupiedSeats: 1,
    status: "open",
  },
  {
    id: "10000000-0000-4000-8000-000000000004",
    source: "player-public",
    tierKey: "high",
    buyInCt: "500",
    smallBlindCt: "25",
    bigBlindCt: "50",
    maxSeats: 6,
    occupiedSeats: 6,
    status: "open",
  },
];

const corsHeaders = {
  "access-control-allow-origin": baseUrl,
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "content-type,x-cv-fingerprint",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "content-type": "application/json",
};

async function installMocks(page) {
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (request.method() === "OPTIONS" && pathname.startsWith("/api/")) {
      await request.respond({ status: 204, headers: corsHeaders });
      return;
    }
    if (pathname === "/api/auth/me") {
      await request.respond({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          user: {
            id: "capture-user",
            email: "capture@example.test",
            name: "Capture Player",
            username: "capture-player",
            emailVerified: true,
            isGuest: false,
          },
        }),
      });
      return;
    }
    if (
      pathname === "/api/cove/poker/cash/tables" &&
      request.method() === "GET"
    ) {
      await request.respond({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true, tables }),
      });
      return;
    }
    if (
      pathname === "/api/cove/poker/cash/tables" &&
      request.method() === "POST"
    ) {
      await request.respond({
        status: 201,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          table: {
            id: "20000000-0000-4000-8000-000000000001",
            source: "private",
            visibility: "private",
            tierKey: null,
            buyInCt: "100",
            smallBlindCt: "5",
            bigBlindCt: "10",
            maxSeats: 6,
            joinCode: "COVE6X",
          },
        }),
      });
      return;
    }
    await request.continue();
  });
}

async function openLobby(browser, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.setCacheEnabled(false);
  await installMocks(page);
  await page.goto(`${baseUrl}/cove/table`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForSelector("h1", { timeout: 30_000 });
  await page.waitForFunction(() =>
    document.body.textContent?.includes("25/50 vCLAW blinds"),
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return page;
}

async function clickButton(page, label) {
  const buttons = await page.$$("button");
  for (const button of buttons) {
    const text = await button.evaluate((candidate) =>
      candidate.textContent?.trim(),
    );
    if (text === label) {
      await button.click();
      return;
    }
  }
  throw new Error(`Button not found: ${label}`);
}

async function assertLayout(page, name, expectSingleColumn) {
  const result = await page.evaluate((singleColumn) => {
    const panel = document.querySelector(
      'section[aria-label="Hold\'em table lobby"] > div',
    );
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const cards = [
      ...document.querySelectorAll('button[aria-label*="table,"]'),
    ];
    const panelRect = panel?.getBoundingClientRect();
    const cardRects = cards.map((card) => card.getBoundingClientRect());
    const clippedCards = cards.filter(
      (card) => card.scrollWidth > card.clientWidth + 1,
    );
    const singleColumnOk =
      !singleColumn ||
      cardRects.length < 2 ||
      cardRects[1].top > cardRects[0].top;
    return {
      pageDoesNotScroll:
        document.documentElement.scrollHeight <= window.innerHeight + 1,
      panelInViewport: Boolean(
        panelRect &&
        panelRect.top >= 0 &&
        panelRect.bottom <= window.innerHeight,
      ),
      tabTargets: tabs.every((tab) => tab.getBoundingClientRect().height >= 44),
      noCardClipping: clippedCards.length === 0,
      singleColumnOk,
    };
  }, expectSingleColumn);
  const failed = Object.entries(result)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  if (failed.length)
    throw new Error(`${name} layout failed: ${failed.join(", ")}`);
  return result;
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--disable-gpu-sandbox",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--use-angle=swiftshader",
    "--no-sandbox",
  ],
});

try {
  const desktop = await openLobby(browser, {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
  });
  console.log("desktop", await assertLayout(desktop, "desktop", false));
  await desktop.screenshot({ path: path.join(outputDir, "lobby-desktop.png") });
  await desktop.close();

  const mobile = await openLobby(browser, {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
  });
  console.log("mobile", await assertLayout(mobile, "mobile", true));
  await mobile.screenshot({ path: path.join(outputDir, "lobby-mobile.png") });
  await mobile.close();

  const create = await openLobby(browser, {
    width: 1024,
    height: 900,
    deviceScaleFactor: 1,
  });
  await clickButton(create, "Create Table");
  await create.waitForFunction(() =>
    document.body.textContent?.includes("Choose a house tier"),
  );
  await create.screenshot({ path: path.join(outputDir, "lobby-create.png") });
  await clickButton(create, "Private table");
  await clickButton(create, "Create private table");
  await create.waitForFunction(() =>
    document.body.textContent?.includes("COVE6X"),
  );
  await create.screenshot({ path: path.join(outputDir, "lobby-code.png") });
  await create.close();

  const viewports = [
    ["ipad-mini-portrait", 744, 1133],
    ["ipad-mini-landscape", 1133, 744],
    ["ipad-air-portrait", 820, 1180],
    ["ipad-air-landscape", 1180, 820],
    ["ipad-pro-portrait", 1024, 1366],
    ["ipad-pro-landscape", 1366, 1024],
  ];
  for (const [name, width, height] of viewports) {
    const page = await openLobby(browser, {
      width,
      height,
      deviceScaleFactor: 1,
    });
    console.log(name, await assertLayout(page, name, false));
    await page.close();
  }
} finally {
  await browser.close();
}
