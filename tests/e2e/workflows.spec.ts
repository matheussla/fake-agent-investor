import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });
const originalId = "64da7e04-85d3-4855-bf18-93ec7f570a4e";

test.beforeEach(async ({ page }) => {
  const state = {
    simulations: [{ id: originalId, status: "active", starting_cash: "10000", created_at: "2026-11-17T10:00:00.000Z" }],
    activeId: originalId, paused: true, pauseReason: null as string | null, cycleRunning: false,
    settings: { version: 1, values: { provider: "grok", model: "grok-4.3", assets: ["BTCUSDT"], cadenceSeconds: 300, feeRate: "0.001", slippageBps: 5, maximumBuyPercent: "0.10", maximumAssetExposure: "0.25", maximumTotalExposure: "0.50", dailyLossLimit: "0.05" } },
    prompts: [{ id: "4b28aad7-ec2c-4936-90be-a8f39e2cff16", name: "Default", version: 1, content: "Follow risk limits.", active: true, created_at: "2026-11-17T10:00:00.000Z" }],
    decisions: [] as Array<Record<string, unknown>>,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/events") return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "id: initial\nevent: snapshot-required\ndata: {}\n\n" });
    if (url.pathname === "/api/simulations" && request.method() === "GET") return route.fulfill({ json: state.simulations });
    if (url.pathname === "/api/portfolio") return route.fulfill({ json: { simulationId: url.searchParams.get("simulationId") ?? state.activeId, cash: "10000", positions: url.searchParams.get("simulationId") === state.activeId ? [{ symbol: "BTCUSDT", quantity: "0.01", cost_basis: "500" }] : [], equity: "10000", equityObservedAt: new Date().toISOString(), realizedProfit: "0", dataStatus: "available" } });
    if (url.pathname === "/api/equity") return route.fulfill({ json: [] });
    if (url.pathname === "/api/markets") return route.fulfill({ json: [{ symbol: "BTCUSDT", bid: "100000", ask: "100010", bidSize: "2", askSize: "2", observed_at: new Date().toISOString() }] });
    if (url.pathname === "/api/candles") return route.fulfill({ json: [] });
    if (url.pathname === "/api/trades") return route.fulfill({ json: [] });
    if (url.pathname === "/api/decisions") return route.fulfill({ json: state.decisions });
    if (url.pathname === "/api/prompts" && request.method() === "GET") return route.fulfill({ json: state.prompts });
    if (url.pathname === "/api/settings" && request.method() === "GET") return route.fulfill({ json: state.settings });
    if (url.pathname === "/api/health") return route.fulfill({ json: { database: "healthy", market: "healthy", agent: { paused: state.paused, generation: 1, cycleRunning: state.cycleRunning, pauseReason: state.pauseReason }, usage: { dailyAttempts: state.decisions.length, providers: { grok: state.decisions.length } }, providers: { grok: "configured", codex: "disabled_isolation_unverified" }, simulation: { id: state.activeId, status: "active" } } });
    if (url.pathname === "/api/prompts" && request.method() === "POST") {
      const body = request.postDataJSON() as { name: string; content: string };
      const version = Math.max(0, ...state.prompts.filter((item) => item.name === body.name).map((item) => item.version)) + 1;
      const prompt = { id: crypto.randomUUID(), name: body.name, version, content: body.content, active: false, created_at: new Date().toISOString() };
      state.prompts.push(prompt);
      return route.fulfill({ status: 201, json: prompt });
    }
    if (url.pathname.match(/^\/api\/prompts\/[^/]+\/activate$/) && request.method() === "POST") {
      const { promptVersionId } = request.postDataJSON() as { promptVersionId: string };
      for (const item of state.prompts) item.active = item.id === promptVersionId;
      return route.fulfill({ json: { activated: true } });
    }
    if (url.pathname === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as { expectedVersion: number; values: typeof state.settings.values };
      if (!state.paused || state.cycleRunning) return route.fulfill({ status: 409, json: { error: { message: "Settings can only change while the agent is paused and idle" } } });
      if (body.expectedVersion !== state.settings.version) return route.fulfill({ status: 409, json: { error: { message: "Configuration version conflict" } } });
      if (state.simulations[0].status === "active" && !body.values.assets.includes("BTCUSDT")) return route.fulfill({ status: 409, json: { error: { message: "Settings cannot remove an asset with a position" } } });
      state.settings = { version: state.settings.version + 1, values: body.values };
      return route.fulfill({ json: state.settings });
    }
    if (url.pathname === "/api/agent/start") {
      if (state.pauseReason === "daily_loss_limit") return route.fulfill({ status: 409, json: { error: { message: "Daily loss pause is not eligible to resume" } } });
      state.paused = false; state.pauseReason = null;
      return route.fulfill({ json: { paused: false } });
    }
    if (url.pathname === "/api/agent/pause") { state.paused = true; state.pauseReason = "manual"; return route.fulfill({ json: { paused: true } }); }
    if (url.pathname === "/api/agent/run-once") {
      if (!state.paused || state.cycleRunning) return route.fulfill({ status: 409, json: { error: { message: "Run Once requires a paused agent" } } });
      const { requestId } = request.postDataJSON() as { requestId: string };
      state.cycleRunning = true;
      state.decisions.unshift({ id: crypto.randomUUID(), request_id: requestId, input_snapshot: { promptVersion: 1 }, result: null, failure: null, created_at: new Date().toISOString() });
      setTimeout(() => { state.cycleRunning = false; state.decisions[0].result = { decision: { action: "hold", explanation: "No trade" } }; }, 150);
      return route.fulfill({ status: 202, json: { id: state.decisions[0].id, simulationId: state.activeId, requestId, status: "pending" } });
    }
    if (url.pathname === "/api/simulations" && request.method() === "POST") {
      const body = request.postDataJSON() as { startingCash: string };
      state.simulations[0].status = "archived";
      const simulation = { id: crypto.randomUUID(), status: "active", starting_cash: body.startingCash, created_at: new Date().toISOString() };
      state.simulations.unshift(simulation); state.activeId = simulation.id; state.paused = true; state.pauseReason = null; state.cycleRunning = false;
      return route.fulfill({ status: 201, json: { id: simulation.id, status: "active" } });
    }
    return route.fulfill({ status: 404, json: { error: { message: "Fixture not found" } } });
  });
});

test("saves, versions, and activates named prompts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Prompt name").fill("Momentum");
  await page.getByLabel("Strategy prompt").fill("Use trend confirmation and respect all risk limits.");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved Momentum version 1" })).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).last().click();
  await expect(page.getByText("Momentum · v1")).toBeVisible();
  await expect(page.getByText("Active for new captures")).toBeVisible();
});

test("protects held assets and paused-only settings while preserving portfolio state on provider switch", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Markets").fill("ETHUSDT");
  await page.getByLabel("Decision provider").selectOption("codex");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "cannot remove an asset with a position" })).toBeVisible();
  await page.getByLabel("Markets").fill("BTCUSDT, ETHUSDT");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/Saved configuration version 2/)).toBeVisible();
  await expect(page.getByText("Codex is disabled because this CLI cannot prove tool isolation.")).toBeVisible();
  await page.getByLabel("Decision provider").selectOption("grok");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/Saved configuration version 3/)).toBeVisible();
  await page.getByRole("button", { name: "Start agent" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Pause agent to edit" })).toBeDisabled();
  await expect(page.getByRole("cell", { name: "0.01", exact: true })).toBeVisible();
});

test("starts, pauses, runs once, and keeps daily loss resume explicit", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start agent" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Run once" }).click();
  await expect(page.getByRole("status").filter({ hasText: "accepted and running" })).toBeVisible();
  await page.goto("/");
  // A loss pause is never resumed by a background refresh; Start is an explicit operator action.
  await page.route("**/api/health", (route) => route.fulfill({ json: { database: "healthy", market: "healthy", agent: { paused: true, generation: 2, cycleRunning: false, pauseReason: "daily_loss_limit" }, usage: { dailyAttempts: 0, providers: {} }, providers: { grok: "configured", codex: "disabled_isolation_unverified" }, simulation: { id: originalId, status: "active" } } }));
  await page.route("**/api/agent/start", (route) => route.fulfill({ status: 409, json: { error: { message: "Daily loss pause is not eligible to resume" } } }));
  await page.reload();
  await page.getByRole("button", { name: "Resume agent" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Daily loss pause is not eligible to resume" })).toBeVisible();
});

test("archives old evidence through the reset dialog and keeps it in history", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Reset simulation" }).click();
  await page.getByLabel("Starting cash (USDT)").fill("2500");
  await page.getByRole("button", { name: "Archive and create" }).click();
  const simulations = page.getByLabel("Simulation", { exact: true });
  await expect(simulations).toContainText("Active");
  await expect(simulations).toContainText("Archived · 64da7e04");
});
