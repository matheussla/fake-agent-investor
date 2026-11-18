import { expect, test } from "@playwright/test";

const simulationId = "64da7e04-85d3-4855-bf18-93ec7f570a4e";
test.beforeEach(async ({ page }) => {
  const agents = ["Trading Lead", "Market Analyst", "Momentum Analyst", "Risk Analyst", "Skeptic"].map((name, index) => ({ id: `agent-${index}`, name, enabled: true, archived: false, isLead: index === 0, status: "idle", prompt: `Describe the role of ${name}. Follow the shared risk limits.` }));
  const messages: Array<Record<string, unknown>> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/reports") return route.fulfill({ json: [] });
    if (path === "/api/events") return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "event: snapshot-required\ndata: {}\n\n" });
    if (path === "/api/simulations") return route.fulfill({ json: [{ id: simulationId, status: "active" }] });
    if (path === "/api/health") return route.fulfill({ json: { agent: { paused: true, cycleRunning: false }, providers: { grok: "configured" }, usage: { dailyAttempts: 6 } } });
    if (path === "/api/settings") return route.fulfill({ json: { version: 1, values: { provider: "grok", model: "grok-4.3", assets: ["BTCUSDT"], dailyAttemptLimit: 500 } } });
    if (path === "/api/portfolio") return route.fulfill({ json: { positions: [], cash: "10000", equity: "10000", dataStatus: "available" } });
    if (["/api/equity", "/api/markets", "/api/trades", "/api/decisions", "/api/market-symbols", "/api/market-candles"].includes(path)) return route.fulfill({ json: [] });
    if (path === "/api/team/runs") return route.fulfill({ json: [] });
    if (path === "/api/agents" && request.method() === "GET") return route.fulfill({ json: agents });
    if (path === "/api/agents" && request.method() === "POST") { const data = request.postDataJSON(); agents.push({ id: "new-agent", name: data.name, enabled: true, isLead: false, archived: false, status: "ready", prompt: data.prompt }); return route.fulfill({ status: 201, json: agents.at(-1) }); }
    if (path.endsWith("/prompts")) return route.fulfill({ json: [{ id: "prompt-1", version: 1, content: "Analyze market trends.", active: true }] });
    if (path === "/api/chat/messages" && request.method() === "POST") { const body = request.postDataJSON(); messages.push({ id: crypto.randomUUID(), cursor: String(messages.length + 1), runId: "run-1", senderAgentId: null, recipientAgentId: body.targetAgentId, senderName: "You", recipientName: agents.find((agent) => agent.id === body.targetAgentId)?.name ?? null, content: body.content, kind: "user", status: "queued", createdAt: new Date().toISOString() }); return route.fulfill({ status: 202, json: { runId: "run-1", message: messages.at(-1) } }); }
    if (path === "/api/chat/messages") return route.fulfill({ json: { messages: messages.filter((message) => Number(message.cursor) > Number(url.searchParams.get("after") ?? 0)), nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Unknown test route" } } });
  });
});

test("preserves the selected agent and unsent draft through navigation and browser history", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: /Risk Analyst/ }).click();
  await page.getByLabel("Message Risk Analyst").fill("Unsent risk question");
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.goBack();
  await page.goBack();
  await expect(page.getByLabel("Message Risk Analyst")).toHaveValue("Unsent risk question");
});

test("shows five agents and creates another with an independent prompt", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("button", { name: /Trading Lead · Lead/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Skeptic/ })).toBeVisible();
  await page.getByRole("button", { name: "Add agent" }).click();
  await page.getByLabel("Agent name").fill("Liquidity Analyst");
  await page.getByLabel("Agent prompt").fill("Analyze liquidity and spread risk.");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("button", { name: /Liquidity Analyst/ })).toBeVisible();
});

test("individual chat persists messages and cannot invoke a trading endpoint", async ({ page }) => {
  const tradeRequests: string[] = [];
  page.on("request", (request) => { if (/\/api\/agent\/(start|run-once)$/.test(request.url())) tradeRequests.push(request.url()); });
  await page.goto("/agents");
  await page.getByRole("button", { name: /Risk Analyst/ }).click();
  await page.getByLabel("Message Risk Analyst").fill("Review the current exposure.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Review the current exposure.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message Risk Analyst")).toHaveValue("");
  await expect(page.getByText("Model calls today: 6 / 500. Chat is discussion-only.")).toBeVisible();
  expect(tradeRequests).toEqual([]);
});

test("live refresh preserves unsaved agent prompt drafts", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: /Market Analyst/ }).click();
  await page.getByRole("button", { name: "Configure agent" }).click();
  await expect(page.getByLabel("Agent prompt")).toHaveValue("Analyze market trends.");
  await page.getByLabel("Agent prompt").fill("My unsaved strategy.");
  await page.waitForTimeout(5500);
  await expect(page.getByLabel("Agent prompt")).toHaveValue("My unsaved strategy.");
});

test("prevents editing until the existing agent prompt is loaded", async ({ page }) => {
  await page.route("**/api/agents/*/prompts?**", async (route) => { await new Promise((resolve) => setTimeout(resolve, 1000)); await route.fallback(); });
  await page.goto("/agents");
  await page.getByRole("button", { name: /Market Analyst/ }).click();
  await page.getByRole("button", { name: "Configure agent" }).click();
  await expect(page.getByLabel("Agent prompt")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save agent and prompt" })).toBeDisabled();
  await expect(page.getByLabel("Agent prompt")).toHaveValue("Analyze market trends.");
  await expect(page.getByLabel("Agent prompt")).toBeEnabled();
});

test("returns to the team conversation after archiving the selected agent", async ({ page }) => {
  let archived = false;
  const agent = { id: "qa-agent", name: "QA Analyst", enabled: true, archived: false, isLead: false, status: "idle" };
  await page.route("**/api/agents?**", (route) => route.fulfill({ json: [{ ...agent, archived }] }));
  await page.route("**/api/agents/qa-agent", (route) => { archived = true; return route.fulfill({ json: { ...agent, archived } }); });
  await page.goto("/agents");
  await page.getByRole("button", { name: /QA Analyst/ }).click();
  await page.getByRole("button", { name: "Configure agent" }).click();
  await page.getByRole("button", { name: "Archive agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Team conversation", exact: true })).toBeVisible();
  await expect(page.getByLabel("Message the team")).toBeVisible();
});

test("failed sends preserve drafts and retry the same idempotency key", async ({ page }) => {
  const keys: string[] = [];
  await page.route("**/api/chat/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    keys.push(route.request().postDataJSON().requestId);
    if (keys.length === 1) return route.fulfill({ status: 503, json: { error: { message: "Temporarily unavailable" } } });
    return route.fallback();
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: /Team conversation All messages/ }).click();
  await page.getByLabel("Message the team").fill("Review risk before the next cycle.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
  await expect(page.getByLabel("Message the team")).toHaveValue("Review risk before the next cycle.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByLabel("Message the team")).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("enables team controls when OpenAI is configured", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { agent: { paused: true, cycleRunning: false }, providers: { grok: "missing_credentials", codex: "configured" }, usage: { dailyAttempts: 0 } } }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: { version: 1, values: { provider: "codex", model: "gpt-5.3-codex" } } }));
  await page.goto("/agents");
  await expect(page.getByRole("button", { name: "Start team", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Run once", exact: true })).toBeEnabled();
});

test("shows each agent's role description instead of idle status", async ({ page }) => {
  await page.goto("/agents");
  const analyst = page.getByRole("button", { name: /Market Analyst/ });
  await expect(analyst).toContainText("Describe the role of Market Analyst.");
  await expect(analyst).not.toContainText("idle");
});

for (const [attempts, percent] of [[0, '0'], [125, '25'], [500, '100'], [600, '100']] as const) {
  test(`shows daily platform allowance at ${attempts} calls`, async ({ page }) => {
    await page.route('**/api/health', (route) => route.fulfill({ json: { agent: { paused: true, cycleRunning: false }, providers: { codex: 'configured' }, usage: { dailyAttempts: attempts, providers: { codex: attempts } } } }));
    await page.goto('/agents');
    const bar = page.getByRole('progressbar', { name: 'Daily platform call allowance' });
    await expect(bar).toHaveAttribute('value', percent);
    await expect(page.getByText(`${attempts} / 500 calls`, { exact: false })).toBeVisible();
    await expect(page.getByText('Automatic stop at 95% of this app budget. OpenAI billing and Codex subscription quotas are not included.')).toBeVisible();
    if (attempts >= 500) await expect(page.getByText('95% usage cutoff reached. Increase the app budget or wait for the UTC reset before restarting.')).toBeVisible();
  });
}
