import { expect, test } from "@playwright/test";

const activeId = "64da7e04-85d3-4855-bf18-93ec7f570a4e";
const archivedId = "6bf6f404-2f64-411b-957c-11bd8bb94af0";
const simulations = [{ id: activeId, status: "active", starting_cash: "10000", created_at: "2026-11-17T10:00:00.000Z" }, { id: archivedId, status: "archived", starting_cash: "5000", created_at: "2026-11-16T10:00:00.000Z" }];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const simulationId = url.searchParams.get("simulationId");
    if (url.pathname === "/api/events") return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: "id: seed\nevent: snapshot-required\ndata: {}\n\n" });
    if (url.pathname === "/api/simulations") return route.fulfill({ json: simulations });
    if (url.pathname === "/api/portfolio") return route.fulfill({ json: { simulationId: simulationId ?? activeId, cash: simulationId === archivedId ? "5000" : "8100", positions: simulationId === archivedId ? [] : [{ symbol: "BTCUSDT", quantity: "0.02", cost_basis: "1800" }], equity: simulationId === archivedId ? "5000" : "10100", equityObservedAt: "2026-11-17T10:00:00.000Z", realizedProfit: "25", dataStatus: "stale" } });
    if (url.pathname === "/api/equity") return route.fulfill({ json: [{ cash: "8100", equity: "10100", realized_profit: "25", unrealized_profit: "0", observed_at: "2026-11-17T10:00:00.000Z" }, { cash: "8100", equity: "10000", realized_profit: "0", unrealized_profit: "0", observed_at: "2026-11-17T09:59:00.000Z" }] });
    if (url.pathname === "/api/markets") return route.fulfill({ json: [{ symbol: "BTCUSDT", bid: "100000", ask: "100010", bidSize: "1", askSize: "1", observed_at: "2026-11-17T10:00:00.000Z" }] });
    if (url.pathname === "/api/candles") return route.fulfill({ json: [{ symbol: "BTCUSDT", openTime: "2026-11-17T09:59:00.000Z", closeTime: "2026-11-17T10:00:00.000Z", open: "99900", high: "100100", low: "99800", close: "100000", volume: "12", closed: true }] });
    if (url.pathname === "/api/trades") return route.fulfill({ json: [{ id: "trade-1", symbol: "BTCUSDT", side: "buy", quantity: "0.02", status: "filled", created_at: "2026-11-17T10:00:00.000Z", price: "90000", fee: "1.8" }] });
    if (url.pathname === "/api/decisions") return route.fulfill({ json: [{ id: "decision-1", request_id: "request-1", result: { decision: { action: "hold" } }, created_at: "2026-11-17T10:00:00.000Z" }] });
    if (url.pathname === "/api/health") return route.fulfill({ json: { database: "healthy", market: "healthy", provider: "unavailable", simulation: { id: activeId, status: "active" } } });
    if (url.pathname === "/api/settings") return route.fulfill({ json: { version: 1, values: { provider: "grok", model: "grok-4.3", assets: ["BTCUSDT"], feeRate: "0.001", slippageBps: 5 } } });
    return route.fulfill({ status: 404, json: { error: "missing fixture" } });
  });
});

test("shows funded portfolio, stale state, charts, and trading evidence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("PAPER TRADING")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Equity history" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "BTCUSDT · 1 minute" })).toBeVisible();
  await expect(page.getByText("Market data is stale")).toBeVisible();
  await expect(page.getByRole("heading", { name: "BTCUSDT" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent trades" })).toBeVisible();
  await expect(page.getByText(/sell execution performance uses bid-side prices/i)).toBeVisible();
});

test("loads archived history and fits a mobile viewport", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Simulation").selectOption(archivedId);
  await expect(page.getByText("No open positions")).toBeVisible();
  await expect(page.getByText("PAPER TRADING")).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", await page.locator("body").evaluate((body) => body.clientWidth));
});

test("shows a useful empty state when no simulation exists", async ({ page }) => {
  await page.route("**/api/simulations", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await expect(page.getByText("No open positions")).toBeVisible();
  await expect(page.getByText("PAPER TRADING")).toBeVisible();
});

test("labels missing market valuation as unavailable", async ({ page }) => {
  await page.route("**/api/portfolio?**", (route) => route.fulfill({ json: { simulationId: activeId, cash: "10000", positions: [], equity: null, equityObservedAt: null, realizedProfit: "0", dataStatus: "unavailable" } }));
  await page.route("**/api/markets?**", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await expect(page.getByText("Portfolio valuation is unavailable until fresh market data arrives.")).toBeVisible();
  await expect(page.getByText("Waiting for exchange quotes")).toBeVisible();
});

test("refetches authoritative data after focus recovery", async ({ page }) => {
  let portfolioReads = 0;
  await page.route("**/api/portfolio?**", async (route) => { portfolioReads += 1; await route.fallback(); });
  await page.goto("/");
  await expect.poll(() => portfolioReads, { timeout: 5000 }).toBeGreaterThan(0);
  const initialReads = portfolioReads;
  await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => portfolioReads, { timeout: 5000 }).toBeGreaterThan(initialReads);
});
