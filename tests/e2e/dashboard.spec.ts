import { expect, test } from "@playwright/test";

const activeId = "64da7e04-85d3-4855-bf18-93ec7f570a4e";
const archivedId = "6bf6f404-2f64-411b-957c-11bd8bb94af0";
const simulations = [{ id: activeId, status: "active", starting_cash: "10000", created_at: "2026-11-17T10:00:00.000Z" }, { id: archivedId, status: "archived", starting_cash: "5000", created_at: "2026-11-16T10:00:00.000Z" }];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/reports") return route.fulfill({ json: [] });
    const simulationId = url.searchParams.get("simulationId");
    if (url.pathname === "/api/events") return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: "id: seed\nevent: snapshot-required\ndata: {}\n\n" });
    if (url.pathname === "/api/simulations") return route.fulfill({ json: simulations });
    if (url.pathname === "/api/portfolio") return route.fulfill({ json: { simulationId: simulationId ?? activeId, cash: simulationId === archivedId ? "5000" : "8100", positions: simulationId === archivedId ? [] : [{ symbol: "BTCUSDT", quantity: "0.02", cost_basis: "1800" }], equity: simulationId === archivedId ? "5000" : "10100", equityObservedAt: "2026-11-17T10:00:00.000Z", realizedProfit: "25", dataStatus: "stale" } });
    if (url.pathname === "/api/equity") return route.fulfill({ json: [{ cash: "8100", equity: "10100", realized_profit: "25", unrealized_profit: "0", observed_at: "2026-11-17T10:00:00.000Z" }, { cash: "8100", equity: "10000", realized_profit: "0", unrealized_profit: "0", observed_at: "2026-11-17T09:59:00.000Z" }] });
    if (url.pathname === "/api/markets") return route.fulfill({ json: [{ symbol: "BTCUSDT", bid: "100000", ask: "100010", bidSize: "1", askSize: "1", observed_at: "2026-11-17T10:00:00.000Z" }] });
    if (url.pathname === "/api/market-symbols") return route.fulfill({ json: [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" }] });
    if (url.pathname === "/api/market-candles") return route.fulfill({ json: [{ symbol: "BTCUSDT", openTime: "2026-11-17T09:59:00.000Z", closeTime: "2026-11-17T10:00:00.000Z", open: "99900", high: "100100", low: "99800", close: "100000", volume: "12", closed: true }] });
    if (url.pathname === "/api/trades") return route.fulfill({ json: [{ id: "trade-1", symbol: "BTCUSDT", side: "buy", quantity: "0.02", status: "filled", created_at: "2026-11-17T10:00:00.000Z", price: "90000", fee: "1.8" }] });
    if (url.pathname === "/api/decisions") return route.fulfill({ json: [{ id: "decision-1", request_id: "request-1", result: { decision: { action: "hold" } }, created_at: "2026-11-17T10:00:00.000Z" }] });
    if (url.pathname === "/api/health") return route.fulfill({ json: { database: "healthy", market: "healthy", agent: { paused: true, generation: 0, cycleRunning: false, pauseReason: null }, usage: { dailyAttempts: 0, providers: {} }, providers: { grok: "configured", codex: "missing_credentials" }, simulation: { id: activeId, status: "active" } } });
    if (url.pathname === "/api/prompts") return route.fulfill({ json: [{ id: "prompt-1", name: "Default", version: 1, content: "hold", active: true, created_at: "2026-11-17T10:00:00.000Z" }] });
    if (url.pathname === "/api/settings") return route.fulfill({ json: { version: 1, values: { provider: "grok", model: "grok-4.3", assets: ["BTCUSDT"], cadenceSeconds: 300, feeRate: "0.001", slippageBps: 5, maximumBuyPercent: "0.10", maximumAssetExposure: "0.25", maximumTotalExposure: "0.50", dailyLossLimit: "0.05" } } });
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

test("loads with local fonts when external font services never respond", async ({ page }) => {
  const externalRequests: string[] = [];
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => {
    externalRequests.push(route.request().url());
    // Leave the request pending to reproduce an unresponsive font service.
  });
  await page.goto("/", { waitUntil: "load", timeout: 5000 });
  await expect(page.getByRole("heading", { name: "Equity history" })).toBeVisible();
  expect(await page.evaluate(async () => {
    const faces = await Promise.all([
      document.fonts.load('400 16px "Manrope"'),
      document.fonts.load('400 16px "DM Mono"'),
      document.fonts.load('500 16px "DM Mono"'),
    ]);
    return faces.map((loaded) => loaded.length);
  })).toEqual([1, 1, 1]);
  expect(externalRequests).toEqual([]);
});

test("loads archived history and fits a mobile viewport", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Simulation", { exact: true }).selectOption(archivedId);
  await expect(page.getByText("No open positions")).toBeVisible();
  await expect(page.getByText("PAPER TRADING")).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", await page.locator("body").evaluate((body) => body.clientWidth));
});

test("refits the equity chart when switching simulations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Chart summary: 2 observations/)).toBeVisible();
  const canvas = await page.getByRole("img", { name: "Paper portfolio equity chart" }).locator("canvas").first().elementHandle();
  await page.getByLabel("Simulation", { exact: true }).selectOption(archivedId);
  await expect(page.getByText("No open positions")).toBeVisible();
  expect(await canvas?.evaluate((element) => element.isConnected)).toBe(false);
  await expect(page.getByRole("img", { name: "Paper portfolio equity chart" }).locator("canvas").first()).toBeVisible();
});

test("does not mix simulation balances while archived history is loading", async ({ page }) => {
  await page.goto("/");
  const profit = page.locator(".metric-card").filter({ hasText: "Total profit" }).locator(".metric-value");
  await expect(profit).toHaveText("100.00 USDT");
  await page.route(`**/api/portfolio?simulationId=${archivedId}`, async (route) => { await new Promise((resolve) => setTimeout(resolve, 1000)); await route.fallback(); });
  await page.getByLabel("Simulation", { exact: true }).selectOption(archivedId);
  await expect(profit).toHaveText("100.00 USDT", { timeout: 500 });
  await expect(profit).toHaveText("0.00 USDT");
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
  await expect(page.locator(".metric-card").filter({ hasText: "Total profit" }).locator(".metric-value")).toHaveText("—");
  await expect(page.locator(".metric-card").filter({ hasText: "Total return" }).locator(".metric-value")).toHaveText("—");
});

test("shows setup guidance and real service health before the first simulation", async ({ page }) => {
  await page.route("**/api/simulations", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await expect(page.getByText("Create your first simulation in Settings to fund a paper portfolio.")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Database" })).toContainText("healthy");
});

test("loads direct links with a trailing slash", async ({ page }) => {
  await page.goto("/settings/");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
});

test("finishes slow refreshes while live events continue", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      onopen = null;
      timer = window.setInterval(() => this.dispatchEvent(new Event("quote")), 250);
      close() { window.clearInterval(this.timer); }
    } as unknown as typeof EventSource;
  });
  await page.route("**/api/portfolio?**", async (route) => { await new Promise((resolve) => setTimeout(resolve, 1600)); await route.fallback(); });
  await page.goto("/");
  await expect(page.locator(".metric-card").filter({ hasText: "Total equity" }).locator(".metric-value")).toContainText("10,100.00", { timeout: 6000 });
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

test("recovers dashboard data automatically after a transient outage", async ({ page }) => {
  let available = false;
  await page.route("**/api/simulations", (route) => available ? route.fallback() : route.fulfill({ status: 503, json: {} }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Reconnecting automatically");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  available = true;
  await expect(page.getByText("10,100.00 USDT", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("shows cycle timing and start, pause, and stop controls on the dashboard", async ({ page }) => {
  let paused = true;
  let running = false;
  await page.route("**/api/health", (route) => route.fulfill({ json: {
    database: "healthy", market: "healthy", simulation: { id: activeId, status: "active" },
    agent: { paused, cycleRunning: running, generation: 0, pauseReason: null },
    cycleTiming: { sessionStartedAt: new Date(Date.now() - 10000).toISOString(), sessionStoppedAt: null, nextCycleAt: paused || running ? null : new Date(Date.now() + 120000).toISOString(), cycleStartedAt: running ? new Date(Date.now() - 10000).toISOString() : null, lastCycleEndedAt: null },
    usage: { dailyAttempts: 6, providers: {} }, providers: { grok: "configured", codex: "missing_credentials" },
  } }));
  await page.route("**/api/agent/start", (route) => { paused = false; return route.fulfill({ json: {} }); });
  await page.route("**/api/agent/pause", (route) => { paused = true; running = false; return route.fulfill({ json: {} }); });
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Trading cycle" });
  await expect(panel.getByText("PAUSED", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Start agent", exact: true }).click();
  await expect(panel.getByText("RUNNING", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Session elapsed/)).toBeVisible();
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(panel.getByText("PAUSED", { exact: true })).toBeVisible();
  paused = false; running = true;
  await page.reload();
  await expect(panel.getByText("RUNNING", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Session elapsed/)).toBeVisible();
  await panel.getByRole("button", { name: "Stop cycle", exact: true }).click();
  await expect(panel.getByText("PAUSED", { exact: true })).toBeVisible();
});

test("offers saved trading reports for future agent analysis", async ({ page }) => {
  await page.route('**/api/reports?**', route => route.fulfill({ json: [{ id: 'report-1', decision_id: 'decision-1', outcome: 'buy', created_at: new Date().toISOString(), metrics: { fees: '0.35', realizedProfitNetOfTradingFees: '0', modelCalls: 6 } }] }));
  await page.goto('/');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trading reports' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Download buy report/ })).toHaveAttribute('href', '/api/reports/report-1');
  await expect(page.getByText(/Fees 0.3500 USDT/)).toBeVisible();
});

test("browses older reports and switches to archived simulations", async ({ page }) => {
  await page.route('**/api/reports?**', route => {
    const url = new URL(route.request().url());
    const rows = url.searchParams.get('simulationId') === archivedId ? [] : url.searchParams.has('before') ? [{ id: 'older', decision_id: 'older-decision', outcome: 'sell', created_at: '2026-11-17T08:00:00.000Z', metrics: { fees: '1', realizedProfitNetOfTradingFees: '2', modelCalls: 6 } }] : Array.from({ length: 20 }, (_, index) => ({ id: `r-${index}`, decision_id: `decision-${index}`, outcome: 'hold', created_at: new Date(Date.UTC(2026, 10, 17, 10, 20 - index)).toISOString(), metrics: { fees: '0', realizedProfitNetOfTradingFees: '0', modelCalls: 6 } }));
    return route.fulfill({ json: rows });
  });
  await page.goto('/reports');
  await page.getByRole('button', { name: 'Older reports' }).click();
  await expect(page.getByRole('link', { name: /Download sell report/ })).toBeVisible();
  await page.getByRole('button', { name: 'Latest reports' }).click();
  await expect(page.getByRole('link', { name: /Download hold report/ })).toHaveCount(20);
  await page.getByLabel('Simulation', { exact: true }).selectOption(archivedId);
  await expect(page.getByText('No saved reports yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Download .* report/ })).toHaveCount(0);
  expect(await page.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
});

test("filters report dates and supports deletion with undo", async ({ page }) => {
  let deleted = false;
  const report = { id: 'report-1', decision_id: 'decision-1', outcome: 'hold', started_at: '2026-11-18T15:00:00Z', created_at: '2026-11-19T15:00:00Z', metrics: { fees: '0', realizedProfitNetOfTradingFees: '0', modelCalls: 6 } };
  await page.route('**/api/reports**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'DELETE') { deleted = true; return route.fulfill({ json: { deleted } }); }
    if (request.method() === 'POST') { deleted = false; return route.fulfill({ json: { deleted } }); }
    return route.fulfill({ json: deleted === (url.searchParams.get('deleted') === 'true') ? [{ ...report, deleted }] : [] });
  });
  await page.goto('/reports');
  await page.getByLabel('Start date', { exact: true }).fill('2026-11-18');
  await page.getByLabel('End date', { exact: true }).fill('2026-11-18');
  const filtered = page.waitForRequest(request => request.url().includes('/api/reports?') && new URL(request.url()).searchParams.has('from'));
  await page.getByRole('button', { name: 'Apply dates' }).click();
  const params = new URL((await filtered).url()).searchParams;
  const expected = await page.evaluate(() => ({ from: new Date(2026, 10, 18).toISOString(), to: new Date(2026, 10, 19).toISOString() }));
  expect(params.get('from')).toBe(expected.from); expect(params.get('to')).toBe(expected.to);
  await page.getByRole('button', { name: 'Delete report decision' }).click();
  await expect(page.getByRole('link', { name: /Download hold report/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo delete' }).click();
  await expect(page.getByRole('link', { name: /Download hold report/ })).toBeVisible();
  await page.getByRole('button', { name: 'Delete report decision' }).click();
  await page.getByLabel('Show deleted reports').check();
  await page.getByRole('button', { name: 'Restore report decision' }).click();
  await page.getByLabel('Show deleted reports').uncheck();
  await expect(page.getByRole('link', { name: /Download hold report/ })).toBeVisible();
  await page.getByRole('button', { name: 'Clear dates' }).click();
  await expect(page.getByLabel('Start date', { exact: true })).toHaveValue('');
});
