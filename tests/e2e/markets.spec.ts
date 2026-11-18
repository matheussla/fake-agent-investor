import { expect, test } from "@playwright/test";

const simulationId = "64da7e04-85d3-4855-bf18-93ec7f570a4e";
const symbols = ["BTC", "ETH", "SOL", "DOGE", "XRP"].map((asset) => ({ symbol: `${asset}USDT`, baseAsset: asset, quoteAsset: "USDT" }));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/reports") return route.fulfill({ json: [] });
    const path = url.pathname;
    if (path === "/api/events") return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "event: snapshot-required\ndata: {}\n\n" });
    if (path === "/api/simulations") return route.fulfill({ json: [{ id: simulationId, status: "active", starting_cash: "10000" }] });
    if (path === "/api/settings") return route.fulfill({ json: { version: 1, values: { assets: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], provider: "grok", model: "grok-4.3" } } });
    if (path === "/api/portfolio") return route.fulfill({ json: { positions: [], cash: "10000", equity: "10000", dataStatus: "available" } });
    if (path === "/api/health") return route.fulfill({ json: { database: "healthy", market: "healthy", agent: { paused: true }, usage: { dailyAttempts: 0 }, providers: { grok: "missing_credentials" } } });
    if (path === "/api/market-symbols") return route.fulfill({ json: symbols });
    if (path === "/api/market-candles" || path === "/api/candles") return route.fulfill({ json: [{ symbol: url.searchParams.get("symbol"), openTime: "2026-11-17T10:00:00.000Z", open: "1", high: "2", low: "0.5", close: "1.5", closed: true }] });
    if (path === "/api/chat/messages") return route.fulfill({ json: { messages: [], nextCursor: null } });
    return route.fulfill({ json: [] });
  });
});

test("searches beyond configured markets and preserves selection across pages", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Select market" }).click();
  const search = page.getByRole("combobox", { name: "Search markets" });
  await search.fill("doge");
  await expect(page.getByRole("option", { name: /DOGE/ })).toBeVisible();
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "DOGEUSDT · 1 minute" })).toBeVisible();
  await expect(page.getByText(/Latest candle: open 1,/)).toBeVisible();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "DOGEUSDT · 1 minute" })).toBeVisible();
  await page.getByRole("button", { name: "Select market" }).click();
  await search.fill("not-a-coin");
  await expect(page.getByText("No matching USDT markets.")).toBeVisible();
  await search.press("Escape");
  await expect(page.getByRole("button", { name: "Select market" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("refreshes data without replacing the chart canvas", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Latest candle: open 1,/)).toBeVisible();
  const canvas = await page.getByRole("img", { name: "BTCUSDT candlestick chart" }).locator("canvas").first().elementHandle();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForResponse((response) => response.url().includes("/api/portfolio"));
  await page.waitForTimeout(500);
  expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true);
});

test("keeps stale market responses out of the selected chart and handles failures", async ({ page }) => {
  await page.route("**/api/market-candles?symbol=DOGEUSDT", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ json: [{ symbol: "DOGEUSDT", openTime: "2026-11-17T10:00:00.000Z", open: "99", high: "100", low: "98", close: "99", closed: true }] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select market" }).click();
  await page.getByRole("combobox", { name: "Search markets" }).fill("doge");
  await page.getByRole("option", { name: /DOGE/ }).click();
  await page.getByRole("button", { name: "Select market" }).click();
  await page.getByRole("combobox", { name: "Search markets" }).fill("xrp");
  await page.getByRole("option", { name: /XRP/ }).click();
  await expect(page.getByRole("heading", { name: "XRPUSDT · 1 minute" })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByText(/Latest candle: open 1,/)).toBeVisible();
  await expect(page.getByText(/Latest candle: open 99,/)).toHaveCount(0);
  await page.route("**/api/market-candles?symbol=ETHUSDT", (route) => route.fulfill({ status: 502, json: {} }));
  await page.getByRole("button", { name: "Select market" }).click();
  await page.getByRole("combobox", { name: "Search markets" }).fill("eth");
  await page.getByRole("option", { name: /ETH/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not load ETHUSDT candles" })).toBeVisible();
});

test("recovers market catalog automatically without a retry button", async ({ page }) => {
  let available = false;
  await page.route("**/api/market-symbols", (route) => available ? route.fallback() : route.fulfill({ status: 502, json: {} }));
  await page.goto("/");
  await page.getByRole("button", { name: "Select market" }).click();
  await expect(page.getByRole("alert")).toContainText("Retrying automatically");
  await expect(page.getByRole("button", { name: "Retry markets" })).toHaveCount(0);
  available = true;
  await expect(page.getByRole("option", { name: /DOGE/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("recovers candles automatically without user action", async ({ page }) => {
  let available = false;
  await page.route("**/api/market-candles?**", (route) => available ? route.fallback() : route.fulfill({ status: 502, json: {} }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Retrying automatically");
  await expect(page.getByRole("button", { name: "Retry candles" })).toHaveCount(0);
  available = true;
  await expect(page.getByText(/Latest candle: open 1,/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});
