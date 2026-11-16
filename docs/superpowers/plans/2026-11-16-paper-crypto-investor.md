# Paper Crypto Investor Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Track steps with checkboxes. Follow the direct-to-`main` workflow below; do not create branches or pull requests.

**Goal:** Build a local paper-trading application that uses real Binance prices and either Grok or Codex to make bounded investment decisions.

**Architecture:** A TypeScript modular monolith with a persistent Fastify backend, React dashboard, PostgreSQL storage, and replaceable market, decision, and execution adapters. Only the backend validates risk and executes simulated trades.

**Tech stack:** React, Vite, Tailwind, TradingView Lightweight Charts, Fastify, Drizzle, PostgreSQL, `decimal.js`, Vitest, `ai`, and `@ai-sdk/xai`. Use pnpm workspaces and Playwright for browser validation.

**Spec:** [Original supplied plan](../specs/2026-11-16-paper-crypto-investor.md), preserved from `/Users/matheusabreu/Downloads/PLAN.md`.

**Status:** Planning only. All 17 implementation tasks are pending. Each task is one tested, reviewed commit followed immediately by a push to `main`.

## Repository baseline and planning decisions

- On November 16, 2026, the repository contained no application files or commits. The configured remote was `git@github.com:matheussla/fake-agent-investor.git`, with no remote branches.
- The source mentions a reference image, but none accompanies it here. Use the described dark trading-terminal style; compare against the image if it becomes available. Pixel-level matching cannot be validated without it.
- The source's Docker/login statements are historical context. Check Docker readiness, Binance connectivity, and provider credentials during implementation; do not assume they remain valid.
- Choose and pin mutually compatible package versions and an actively supported Node.js LTS during Task 1. Record the actual versions in the lockfile and setup instructions.
- Proposed choices where the spec is silent: reject execution quotes older than 5,000 ms; Run Once executes while paused and returns to paused; scheduled Start waits one configured interval before its first cycle. All controls share the same risk and usage gates.
- Use base-asset quantity decimal strings for buy/sell decisions. Reject quantities that violate exchange increments instead of silently changing the requested amount.
- Start with a valid default strategy prompt, versioned like user prompts. No cloud hosting, real-money adapter, authenticated exchange keys, or additional services are part of version one.

## Global constraints

- One active simulation, one portfolio, one selected AI provider; spot purchases and sales only, with no borrowing, leverage, or shorts.
- Defaults: **10,000 virtual USDT**; **BTC/USDT, ETH/USDT, SOL/USDT**; **one decision every five minutes**; **at most one order per decision**.
- Limits: maximum buy size **10% of equity**, asset exposure **25%**, total exposure **50%**. A **5% daily equity loss** pauses execution without liquidation and requires explicit resume after the condition clears or limits change.
- Buy at ask plus **five basis points**; sell at bid minus **five basis points**; simulated fees default to **0.1% per side**. Complete fills only; validate cash, holdings, quote size, exchange increments, notional limits, and freshness.
- Use `decimal.js`, PostgreSQL `NUMERIC`, and decimal strings at API/model boundaries. Keep UTC timestamps. Never use JavaScript floating-point arithmetic for monetary decisions.
- Persist immutable funding/trade/fee/balance evidence and commit fills, ledger movements, and positions atomically. Weighted-average acquisition cost includes buy fees; realized profit deducts sell fees.
- Equity equals cash plus holdings valued at current bids. Display realized, unrealized, and total profit separately. Win rate and average realized profit use sell executions, with that basis visible.
- Retain one-second quote samples for **24 hours**, closed candles for **90 days**, and decision evidence, trading records, and minute equity snapshots for each simulation.
- Start and restart paused. Continue ingestion and valuation while paused. Prevent concurrent cycles and duplicate fills; never replay missed cycles.
- Decision timeout: **90 seconds**. Default allowance: **300 attempts per UTC day**. Pause after **three consecutive provider failures** or allowance exhaustion. Cancel pending decisions on pause and reject late responses.
- Settings change only while paused. Held assets cannot be removed. Provider switching preserves balances/history. Prompt activation affects the next cycle; an existing cycle retains its captured version. Reset archives the prior simulation.
- Run Node.js locally and PostgreSQL through Docker Compose. Bind application and database ports to loopback. Enforce same-origin browser access and keep secrets server-side.
- Grok uses configurable `grok-4.3` and `XAI_API_KEY`; API billing is separate from virtual funds. Codex uses the installed CLI and existing login without changing user configuration or copying credentials.
- Codex requires an isolated working directory, restricted environment, read-only permissions, and disabled execution tools, plugins, hooks, and external connectors. Models receive no database access or trade execution capability.
- Dashboard controls must be keyboard-accessible and responsive. Display **PAPER TRADING**, provider identity, simulation assumptions, stale/unavailable data, real module health, and usage. Throttle display updates to once per second and reload authoritative state after SSE reconnection.

## Commit and push protocol

The documentation commit that introduces this plan precedes Task 1. Execute Tasks 1–17 in order; do not batch tasks into one commit or defer their pushes.

1. Confirm `git branch --show-current` returns `main` and inspect `git status --short`. Preserve unrelated user changes.
2. Once `origin/main` exists, run `git fetch origin` and `git pull --ff-only origin main` before starting a task. Resolve divergence without force-pushing or rewriting published commits.
3. Write focused tests first for nontrivial behavior, confirm the expected failure, then implement the task. Run its listed checks and the shared checks below.
4. Review the diff for correctness, security, scope, and maintainability. Include this task's checklist updates in its own commit. A task is complete only when its checks pass and its commit is confirmed on `origin/main`; Git provides the publication record without a separate bookkeeping commit.
5. Stage only the task's files and this progress document. Commit using the task's exact message, then run `git push -u origin main` immediately.
6. Confirm local `HEAD` equals `git ls-remote origin refs/heads/main`. Do not start the next task until the push succeeds. Report a rejected push; never bypass repository protection.

**Shared checks after Task 1:** `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, and `pnpm build`. Run `pnpm test:integration` for database/backend changes after Task 2, and `pnpm test:e2e` for browser changes after Task 14. Tests must not invoke paid providers unless explicitly selected as live smoke checks.

**Completion evidence:** Each task records its commands/results in the implementation handoff and explains any external blocker. A skipped required test is not a passing test. Use normal commit prose; include no assistant co-author attribution.

## File and interface map

Paths below are planned, not existing files. Add corresponding `index.ts` exports/package configuration where needed; avoid placeholder implementations for later tasks.

- `apps/server/src/app.ts`, `index.ts`, `config.ts`: Fastify assembly, process lifecycle, validated environment.
- `apps/server/src/db/`: schema, migrations, transaction access, test database support.
- `apps/server/src/modules/{simulations,accounting,execution,market,portfolio,prompts,settings,risk,decisions,agent}/`: business behavior with colocated tests.
- `apps/server/src/providers/{binance,grok,codex}.ts`: external integrations behind contracts.
- `apps/server/src/http/`: read routes, control routes, origin checks, SSE.
- `apps/web/src/{components,features,lib}/`: dashboard, controls, API/SSE clients.
- `packages/contracts/src/{domain,providers,http}.ts`: runtime schemas and inferred TypeScript types shared by server and browser. Use one schema library, such as Zod, compatible with the selected SDK versions.
- `tests/integration/`, `tests/e2e/`, `scripts/smoke.ts`: database races, browser workflows, explicit live checks.

Define these contracts in Task 1; implement them in their owning tasks:

```ts
type Decision =
  | { action: "hold"; explanation: string }
  | { action: "buy" | "sell"; symbol: string; quantity: string; explanation: string };

interface MarketDataProvider {
  instruments(signal: AbortSignal): Promise<Instrument[]>;
  quote(symbol: string, signal: AbortSignal): Promise<Quote>;
  candles(request: CandleRequest, signal: AbortSignal): Promise<Candle[]>;
  subscribe(symbols: string[], emit: (event: MarketEvent) => void): () => void;
  health(): ProviderHealth;
}
interface DecisionProvider {
  decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionResult>;
}
interface ExecutionProvider {
  submit(order: ApprovedOrder, signal: AbortSignal): Promise<ExecutionResult>;
  status(orderId: string): Promise<OrderStatus>;
  fills(orderId: string): Promise<Fill[]>;
  cancel(orderId: string): Promise<CancelResult>;
  reconcile(simulationId: string): Promise<ReconciliationResult>;
}
```

`domain.ts` defines the named types: normalized instruments with exchange filters; bid/ask prices and sizes with observation/receipt times; UTC candles; module health; simulation-scoped positions, balances, version IDs, and order/fill records. `DecisionInput` captures immutable portfolio/market snapshots, limits, provider/model, configuration version, and prompt version. `DecisionResult` includes the validated decision and available usage metadata; unavailable usage is explicitly unknown. `ApprovedOrder` carries the decision ID, simulation ID, run generation, configuration version, quantity, and execution quote. Approval is revalidated inside execution; a TypeScript type is not an authorization boundary.

## Review focus

- Out-of-order quotes, stale holdings prices, and Binance reconnect gaps must never produce apparently fresh equity or valid trades: Tasks 5–7 and 9.
- UTC midnight, downtime, and missing prices must not reset loss protection or replenish usage incorrectly: Tasks 6, 9, and 12.
- Pause/reset racing an accepted decision must prevent a late fill or cross-simulation write: Tasks 4, 8, 12, and 16.
- Minimum increments, tiny residual holdings, and repeated partial sales must preserve exact accounting identities: Tasks 3–4.
- Inherited CLI tools/configuration and malicious browser origins must not expose credentials or bypass trading limits: Tasks 11, 13, and 16.

## Stage 1 — Persistence, accounting, and deterministic execution

### Task 1: Bootstrap the local workspace and shared contracts

**Dependencies:** None. **Commit:** `chore(app): bootstrap local TypeScript workspace`

**Files:** Create root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.env.example`, `.node-version`; app/package manifests; `apps/server/src/{app,index,config}.ts`; `apps/web/{index.html,vite.config.ts,src/main.tsx}`; `packages/contracts/src/{domain,providers,http}.ts` and `domain.test.ts`.

**Interfaces:** Produce the contracts above, `buildApp(): FastifyInstance`, validated environment, and root development/check scripts.

- [ ] Add schema tests rejecting invalid decimal strings, nonpositive prices/order quantities, extra actions, unknown decision fields, and malformed environment values. Permit signed profit and ledger deltas. Run `pnpm test:unit packages/contracts/src/domain.test.ts` and confirm the intended failure.
- [ ] Implement strict schemas, the minimal server/client shell, loopback binding, and same-origin Vite proxy. Separate server secrets from browser environment variables. Configure unit/integration Vitest projects; root `test:unit` runs `vitest run --project unit`.
- [ ] Run shared checks; start development processes and confirm the client and liveness endpoint respond. Liveness must not claim unimplemented modules are healthy.
- [ ] Review, commit, and push this task using the protocol.

### Task 2: Add PostgreSQL persistence and simulation creation

**Depends on:** 1. **Commit:** `feat(db): persist simulations and trading evidence`

**Files:** Create `compose.yaml`, `apps/server/drizzle.config.ts`, `apps/server/src/db/{client,schema}.ts`, `apps/server/src/db/migrations/`, `apps/server/src/modules/simulations/service.ts`, and `tests/integration/{setup,database.integration.test}.ts`; modify environment/scripts.

**Interfaces:** Produce `createSimulation(input: NewSimulationInput): Promise<Simulation>` and database transaction access. Define input/output types in contracts.

- [ ] Add failing integration checks for migration replay, one active simulation, unique decision/order/fill identities, immutable ledger writes, and rejected invalid foreign keys/negative holdings; run `pnpm test:integration tests/integration/database.integration.test.ts`.
- [ ] Create portfolios/simulations, configuration and prompt versions, decision inputs/results, orders, fills, ledger entries, positions, equity history, quote samples, candles, operational events, UTC daily usage/baselines, and agent state. Use appropriate `NUMERIC` precision, indexes, and uniqueness constraints. Prevent ledger update/delete through the application database role.
- [ ] Add Compose PostgreSQL with a loopback port, health check, persistent volume, migrations, and isolated test database. Create initial paused simulation and funding entry atomically, using 10,000 USDT by default.
- [ ] Re-run integration checks against real PostgreSQL and shared checks. Confirm restart preserves records; test cleanup must never target the development database.
- [ ] Review, commit, and push this task.

### Task 3: Implement exact portfolio accounting

**Depends on:** 2. **Commit:** `feat(accounting): add decimal ledger and profit calculations`

**Files:** Create `apps/server/src/modules/accounting/{decimal,ledger,positions,metrics}.ts`, `accounting.test.ts`, and `tests/integration/accounting.integration.test.ts`.

**Interfaces:** Produce `applyFill(tx: DbTransaction, fill: Fill): Promise<void>` and `valuePortfolio(snapshot: PortfolioSnapshot, quotes: Quote[]): PortfolioValuation`; define their types in contracts.

- [ ] Add failing tests for buy fees in cost basis, partial sales, sell fees, zero balances, rounding boundaries, and the accounting identity `totalProfit = realizedProfit + unrealizedProfit`. Run focused unit/integration suites.
- [ ] Implement explicit decimal precision and rounding rules, immutable balance movements, weighted-average cost, bid valuation, and sell-execution performance statistics. Clear residual cost when the final position quantity reaches zero; show unavailable percentages for zero denominators.
- [ ] Verify this exact fixture from 10,000 USDT: buy 1 at ask 100 with 5 bps slippage and 0.1% fee; cash is `9899.84995`, acquisition cost `100.15005`. Sell 0.4 at bid 110: net proceeds `43.934022`, realized profit `3.874002`, remaining cost `60.09003`. At bid 110, equity is `10009.783972` and unrealized profit `5.90997`.
- [ ] Run `pnpm test:unit apps/server/src/modules/accounting/accounting.test.ts`, the accounting integration suite, and shared checks.
- [ ] Review, commit, and push this task.

### Task 4: Add atomic paper execution and order validation

**Depends on:** 3. **Commit:** `feat(execution): add atomic paper fills and exchange checks`

**Files:** Create `apps/server/src/modules/execution/{paper,validation}.ts`, `paper.test.ts`, and `tests/integration/execution.integration.test.ts`.

**Interfaces:** Implement `ExecutionProvider` as `PaperExecutionProvider`, consuming `ApprovedOrder` and `applyFill`.

- [ ] Add failing tests for insufficient cash including fees, insufficient holdings, invalid increments/notional, inadequate displayed size, stale quotes, and unsupported precision. Cover a duplicate decision, two concurrent submissions, and injected transaction failure.
- [ ] Calculate ask/bid slippage and fee deterministically. Lock portfolio/agent state, revalidate quote and expected configuration/run generation, and commit order/fill/ledger/positions together. Enforce one order per decision and one complete fill per order; rejection creates evidence without changing balances.
- [ ] Refresh stale quotes before entering the short transaction, then recheck age/state inside it. Perform no external I/O while holding the transaction lock. Expose truthful terminal order status, fills, cancellation outcome, and reconciliation results; do not simulate asynchronous partial fills.
- [ ] Run focused execution unit/integration suites and shared checks. Assert one fill under contention and no partial financial writes after rollback.
- [ ] Review, commit, and push this task.

## Stage 2 — Binance data, valuation, and streaming reads

### Task 5: Implement resilient Binance ingestion

**Depends on:** 4. **Commit:** `feat(market): ingest Binance quotes candles and trading rules`

**Files:** Create `apps/server/src/providers/binance.ts`, `apps/server/src/modules/market/{ingestion,cache}.ts`, and `binance.test.ts` beside the provider.

**Interfaces:** Implement `MarketDataProvider`; publish normalized `MarketEvent` values with instrument rules, bid/ask sizes, ticker statistics, and one-minute candles.

- [ ] Add failing fixture-driven tests for REST bootstrap, heartbeat, disconnect/reconnect, duplicate/out-of-order messages, candle gaps, throttling, and inaccessible markets; run `pnpm test:unit apps/server/src/providers/binance.test.ts`.
- [ ] Bootstrap instruments/history through public production REST; ingest production WebSocket book/ticker/kline streams. Use bounded backoff, timeout/cancellation, heartbeat handling, deduplication, and REST candle backfill. Track per-symbol freshness separately from socket connectivity.
- [ ] Respect applicable exchange filters and current stream/rate limits. A quiet ticker message must not make an old bid/ask fresh. Make unsupported/delisted instruments unavailable with a recorded reason.
- [ ] Run provider tests and shared checks; reserve the network-dependent smoke check for Task 17.
- [ ] Review, commit, and push this task.

### Task 6: Persist market history and continuous valuation

**Depends on:** 5. **Commit:** `feat(portfolio): persist market history and equity snapshots`

**Files:** Create `apps/server/src/modules/market/retention.ts`, `apps/server/src/modules/portfolio/valuation.ts`, and `tests/integration/valuation.integration.test.ts`.

**Interfaces:** Produce `refreshValuation(simulationId: string): Promise<PortfolioValuation>` and persisted quote/candle/equity queries.

- [ ] Add failing tests for 24-hour quote and 90-day candle cutoffs, candle upserts, once-per-minute equity records, restart recovery, and stale/missing quotes for a held asset.
- [ ] Sample quotes at most once per symbol per second; persist closed candles and minute equity snapshots. Run valuation and retention while the agent is paused. Keep decision snapshots independent of expiring market history; never delete simulation evidence through retention.
- [ ] Persist each UTC day's first fresh valuation as its baseline; retain the prior baseline during normal same-day restarts. Record the observation timestamp and delayed-baseline status if midnight prices are unavailable; reject trading until a valid current-day baseline exists. Expose stale valuation rather than inventing prices or backfilling fictitious equity after downtime.
- [ ] Run `pnpm test:integration tests/integration/valuation.integration.test.ts` and shared checks; test exact UTC boundaries with a controlled clock.
- [ ] Review, commit, and push this task.

### Task 7: Expose validated reads and SSE updates

**Depends on:** 6. **Commit:** `feat(api): expose portfolio queries and live event stream`

**Files:** Create `apps/server/src/http/{read-routes,sse,origin}.ts`, `read-routes.test.ts`, and `sse.test.ts`; extend `packages/contracts/src/http.ts` and server assembly.

**Interfaces:** Produce `GET /api/portfolio`, `/positions`, `/equity`, `/markets`, `/trades`, `/decisions`, `/prompts`, `/settings`, `/health`, `/simulations`, and `/events` under `/api`. Collections support bounded pagination; histories support validated time ranges and simulation IDs.

- [ ] Add failing route tests for decimal-string responses, invalid filters, pagination, archived history, module health, and SSE disconnect/slow-client cleanup.
- [ ] Implement read schemas and structured errors. Emit simulation-scoped market, portfolio, decision, execution, and status events with IDs/timestamps. Coalesce display updates to one second while retaining all audit events in storage; mark reconnects as requiring a fresh authoritative snapshot.
- [ ] Enforce allowed Host/Origin values and Fetch Metadata for browser reads/SSE. Expose module status, data age, and available provider usage without secrets. Report missing credentials and unimplemented providers as unavailable.
- [ ] Run focused HTTP unit suites and shared checks; verify streaming does not leak subscriptions after clients close.
- [ ] Review, commit, and push this task.

## Stage 3 — Prompts, risk, providers, and agent lifecycle

### Task 8: Add versioned prompts, settings, and simulation reset

**Depends on:** 7. **Commit:** `feat(strategy): version prompts settings and simulation resets`

**Files:** Create `apps/server/src/modules/prompts/service.ts`, `apps/server/src/modules/settings/service.ts`, `tests/integration/strategy.integration.test.ts`; extend simulation service and contracts.

**Interfaces:** Produce `savePrompt(input: SavePromptInput): Promise<PromptVersion>`, `activatePrompt(promptVersionId: string): Promise<void>`, `updateSettings(input: SettingsUpdate): Promise<ConfigurationVersion>`, and `resetSimulation(input: NewSimulationInput): Promise<Simulation>`.

- [ ] Add failing checks for named prompt versions, immutable historical versions, activation during a cycle, settings while running, held-asset removal, and provider switching with unchanged balances/history.
- [ ] Implement bounded prompt/settings schemas and optimistic version checks. Allow provider/model/assets/cadence/risk changes only while paused. Capture exact prompt/configuration versions in decision inputs; activation changes only future captures.
- [ ] Implement reset as one transaction that archives the old simulation, invalidates its run generation, and creates a newly funded paused simulation. Keep all old evidence queryable; never delete or repurpose old rows. Prevent duplicate resets using a request idempotency key.
- [ ] Run `pnpm test:integration tests/integration/strategy.integration.test.ts` and shared checks. Assert stale versions conflict and a reset cannot leave two active simulations.
- [ ] Review, commit, and push this task.

### Task 9: Enforce portfolio risk and daily loss pauses

**Depends on:** 8. **Commit:** `feat(risk): enforce exposure limits and daily loss pauses`

**Files:** Create `apps/server/src/modules/risk/{evaluate,daily-loss}.ts`, `risk.test.ts`, `tests/integration/risk.integration.test.ts`; extend paper execution and valuation hooks.

**Interfaces:** Produce `evaluateRisk(input: RiskInput): RiskResult` and `enforceDailyLoss(simulationId: string): Promise<void>`. Store explicit rejection/pause reason codes.

- [ ] Add failing boundary tests at and above 10% buy size, 25% asset exposure, 50% total exposure, and 5% daily loss. Include price drift, stale held-asset prices, invalid amounts, and a prompt asking to bypass limits.
- [ ] Use fresh bid-valued equity, executable ask/bid prices, and fees to evaluate projected balances/exposure. Define buy-size conservatively as total cash debit including fees. Allow risk-reducing sells when exposure is already too high; enforce the global loss pause for all execution without liquidation.
- [ ] Revalidate financial risk inside the fill transaction against current state, not the model's snapshot. Check daily loss on fresh valuation and immediately before execution. Persist and latch the pause; recovery or changed limits makes explicit resume eligible but never resumes automatically.
- [ ] Test midnight, restarts, and missing baseline data. Run `pnpm test:unit apps/server/src/modules/risk/risk.test.ts`, the risk integration suite, and shared checks. At a 10,000 baseline, equity of 9,500 must pause.
- [ ] Review, commit, and push this task.

### Task 10: Add decision context validation and the Grok adapter

**Depends on:** 9. **Commit:** `feat(grok): add structured investment decisions and usage`

**Files:** Create `apps/server/src/modules/decisions/{context,validation}.ts`, `apps/server/src/providers/grok.ts`, and `grok.test.ts`; add selected AI SDK dependencies and environment documentation.

**Interfaces:** Implement `GrokDecisionProvider.decide(input, signal)` and `buildDecisionInput(simulationId: string): Promise<DecisionInput>`.

- [ ] Add failing mocked tests for valid buy/sell/hold, unknown assets, extra actions/fields, malformed quantities, provider failure, quota rejection, cancellation, and invalid structured output.
- [ ] Capture bounded portfolio/market context and the exact activated prompt/configuration. Use `ai` and `@ai-sdk/xai` structured output with configurable `grok-4.3`. Treat model output as untrusted; no tools, DB access, or direct execution.
- [ ] Keep `XAI_API_KEY` exclusively on the server. Record latency, model, response outcome, and available usage with redacted errors. Disable hidden SDK retries so one counted attempt means one request; apply caller cancellation and the shared 90-second deadline.
- [ ] Run `pnpm test:unit apps/server/src/providers/grok.test.ts` and shared checks with no network/key requirement. Display usage separately from simulated balances and do not invent monetary API costs.
- [ ] Review, commit, and push this task.

### Task 11: Verify Codex isolation and implement the CLI adapter

**Depends on:** 10. **Commit:** `feat(codex): add isolated structured decision adapter`

**Files:** Create `apps/server/src/providers/codex.ts`, `codex.test.ts`, `tests/integration/codex-isolation.integration.test.ts`, and `docs/codex-isolation.md`.

**Interfaces:** Implement `CodexDecisionProvider.decide(input, signal)` and `checkCodexCapabilities(): Promise<ProviderHealth>` without changing user configuration.

- [ ] First inspect the installed CLI's help and current official configuration documentation. Prove how to disable command execution, plugins, hooks, connectors/MCP, and other tools while retaining existing authentication. Record effective controls and minimum supported behavior. **Do not enable this provider if those requirements cannot be demonstrated.**
- [ ] Add failing child-process fixture tests for argument construction, an allowlisted environment, missing login, malformed/truncated JSONL, invalid schema output, nonzero exit, output-size limits, timeout, and process-tree cancellation.
- [ ] Spawn without a shell from an isolated temporary directory. Supply context through stdin, request JSON events and a final output schema, use read-only permissions, and apply verified per-invocation isolation. Preserve the login's original authentication location without reading/copying credentials or editing the user's files. Exclude application secrets and database connection values from child inputs/environment.
- [ ] Demonstrate that inherited hooks, plugins, instructions, and connectors cannot trigger execution or secret access using harmless canary fixtures. Read-only sandboxing alone does not prove tool isolation. Parse only the validated final response; redact diagnostics and clean temporary files.
- [ ] Run focused Codex unit/isolation suites and shared checks. Keep the real bounded model call for Task 17; report unsupported isolation as an explicit blocker, not successful completion.
- [ ] Review, commit, and push this task.

### Task 12: Implement the persistent scheduler and cancellation rules

**Depends on:** 11. **Commit:** `feat(agent): add guarded scheduling pause and run once`

**Files:** Create `apps/server/src/modules/agent/{service,scheduler,usage}.ts`, `agent.test.ts`, and `tests/integration/agent.integration.test.ts`; wire startup, shutdown, and valuation-triggered pauses.

**Interfaces:** Produce `startAgent(): Promise<AgentState>`, `pauseAgent(reason: PauseReason): Promise<AgentState>`, and `runOnce(requestId: string): Promise<DecisionRecord>`.

- [ ] Add failing fake-clock/database tests for five-minute cadence, concurrent Start/Run Once, 90-second timeout, three consecutive provider failures, the 300th/301st attempt, UTC allowance rollover, and restart while a decision is pending.
- [ ] Atomically claim one cycle with database locking and a run generation; release transactions before provider I/O. Capture versions/context, reserve usage, request a decision, validate risk, then submit at most one paper order. Persist hold/rejection/failure evidence without trading.
- [ ] Keep daily attempt accounting across restarts, provider switches, and simulation resets; use an application-wide UTC counter with per-provider details. A successful validated response resets consecutive provider failures; a valid hold/risk rejection is not a provider failure. A cancelled dispatched request still counts.
- [ ] Pause aborts pending work and increments the generation. Before execution, recheck generation, configuration, active simulation, loss latch, and usage reservation. Reject late results and duplicate Run Once request IDs. Run Once requires paused state, shares all limits, and leaves scheduling paused.
- [ ] On startup, invalidate interrupted cycles and start paused; do not catch up missed intervals. On shutdown, abort work and close streams safely. Run the focused unit/integration suites and shared checks, including pause/timeout versus fill races.
- [ ] Review, commit, and push this task.

### Task 13: Add local control APIs and browser request protection

**Depends on:** 12. **Commit:** `feat(api): add validated agent and simulation controls`

**Files:** Create `apps/server/src/http/control-routes.ts`, `control-routes.test.ts`, `tests/integration/control-routes.integration.test.ts`; extend origin checks and HTTP schemas.

**Interfaces:** Produce `POST /api/agent/start`, `POST /api/agent/pause`, `POST /api/agent/run-once`; `POST /api/prompts`; `POST /api/prompts/:promptId/activate`; `PATCH /api/settings`; `POST /api/simulations`. Activation body selects a version belonging to the path's prompt. Settings include the expected version; reset/run-once include idempotency keys.

- [ ] Add failing tests for every success path, missing fields, invalid types/ranges, stale versions, duplicate requests, lifecycle conflicts, and unexpected browser origins.
- [ ] Wire validated bodies to domain services. Require same-origin browser requests, an allowed Host, JSON bodies, and explicit Origin on mutations; reject missing/foreign/null origins. Do not enable permissive CORS. Document that local command-line tests must supply the configured Origin.
- [ ] Return consistent errors: 400 invalid input, 403 origin rejection, 409 state/version conflict, 429 exhausted allowance, and 503 unavailable dependencies. Make long-running decisions observable through their record/SSE; return accepted run-once requests promptly instead of holding an HTTP connection for 90 seconds.
- [ ] Run route unit/integration suites and shared checks. Confirm no API path bypasses scheduler/risk rules or exposes secrets, and archived simulations cannot be mutated.
- [ ] Review, commit, and push this task.

## Stage 4 — Dashboard, workflow validation, and documentation

### Task 14: Build the live trading dashboard

**Depends on:** 13. **Commit:** `feat(ui): build live paper trading dashboard`

**Files:** Create `apps/web/src/{App.tsx,styles.css}`, `apps/web/src/lib/{api,events}.ts`, `apps/web/src/features/dashboard/{Dashboard,EquityChart,MarketChart,Positions,History,Activity,Health}.tsx`, `playwright.config.ts`, and `tests/e2e/dashboard.spec.ts`.

**Interfaces:** Consume the read API and SSE contracts; provide one authoritative query state refreshed after reconnect, focus recovery, and simulation changes.

- [ ] Add failing browser checks for empty/funded/position states, stale/unavailable data, SSE disconnect/reconnect, and archived history. Configure deterministic local fixtures with no paid provider calls.
- [ ] Build the dark responsive terminal layout with persistent PAPER TRADING/provider labels; equity/cash/profit/exposure/performance cards; equity/candlestick charts; positions/trades; activity; real health/freshness/usage. Label fees, slippage, complete-fill assumptions, and sell-execution performance basis.
- [ ] Use Lightweight Charts only for presentation. Convert decimal strings to chart numbers at the display boundary; never feed chart-rounded values back into trading. Preserve readable tables, keyboard navigation, visible focus, and chart text summaries. Batch UI updates once per second and refetch all authoritative state after reconnection.
- [ ] Run `pnpm test:e2e tests/e2e/dashboard.spec.ts` and shared checks. Verify desktop/mobile layouts, non-color status cues, and no duplicated subscriptions after remounts.
- [ ] Review, commit, and push this task.

### Task 15: Build prompt, settings, and lifecycle workflows

**Depends on:** 14. **Commit:** `feat(ui): add strategy settings and agent controls`

**Files:** Create `apps/web/src/features/{prompts/PromptEditor,settings/Settings,agent/Controls,simulations/ResetDialog}.tsx` and `tests/e2e/workflows.spec.ts`; connect dashboard navigation.

**Interfaces:** Consume control APIs and expose Start, Pause, Run Once, named prompt save/activation, settings, provider switching, and archive-preserving reset.

- [ ] Add failing workflow checks for prompt save/version/activation, provider readiness, paused-only settings, held-asset removal, Start/Pause/Run Once, loss-pause resume, reset, and preserved archived history.
- [ ] Implement keyboard-accessible forms/dialogs with validation, pending/error states, version-conflict recovery, and duplicate-submit protection. Show the active and in-flight prompt versions distinctly when needed. Require confirmation of a new simulation and explain archival behavior.
- [ ] Keep server state authoritative: stale UI cannot enable an invalid action. Surface missing Docker/database/market/provider readiness with actionable setup guidance. Provider switching must visibly preserve positions and totals.
- [ ] Run `pnpm test:e2e tests/e2e/workflows.spec.ts`, existing browser tests, and shared checks. Verify a paused agent still receives live market/valuation updates.
- [ ] Review, commit, and push this task.

### Task 16: Validate concurrency, recovery, and security end to end

**Depends on:** 15. **Commit:** `test(system): cover races recovery and secret isolation`

**Files:** Create `tests/integration/{recovery,security}.integration.test.ts`, `tests/e2e/recovery.spec.ts`, and `docs/validation.md`; modify owning modules only for discovered defects.

**Interfaces:** Exercise the complete application with real PostgreSQL, deterministic provider doubles, and fault injection.

- [ ] Reproduce pause/reset/provider-switch races, duplicate execution across two server processes, rollback after each financial write, and process termination during a decision/fill. Assert zero late/cross-simulation fills, at-most-once effects, and paused restart without replay.
- [ ] Exercise Binance interruptions, stale held-asset prices, delayed UTC baseline, quota/timeout/malformed output, prompt injection, slow SSE consumers, and browser reconnection. Verify truthful health and recoverable state without silent data loss.
- [ ] Verify malicious/null/missing origins on mutations, hostile Host headers, foreign-origin SSE, sanitized errors, browser bundles/responses without secrets, and isolated Codex execution. Run every Task 11 canary check with the supported local runtime.
- [ ] Run all shared, integration, and browser suites. Record pass/fail counts and map each source-plan requirement to test evidence in `docs/validation.md`; fix discovered defects and rerun affected suites before the full gate.
- [ ] Review, commit, and push this task.

### Task 17: Document setup and complete bounded live checks

**Depends on:** 16. **Commit:** `docs(app): document setup and verify live integrations`

**Files:** Create `README.md`, `scripts/smoke.ts`, `scripts/smoke.test.ts`; update `.env.example`, root scripts, `docs/validation.md`, and `docs/codex-isolation.md` with verified instructions/results.

**Interfaces:** Produce documented `pnpm smoke:binance`, `pnpm smoke:grok`, and `pnpm smoke:codex` commands; smoke scripts never start scheduled trading or alter portfolio balances.

- [ ] Add tests proving smoke calls are bounded, abort on timeout, do not retry providers, and cannot place orders. Document pinned runtime/package versions, Docker startup, migration/test commands, local URLs, environment variables, existing Codex login, and provider readiness.
- [ ] Document accounting/performance definitions, simulation assumptions, retention, UTC baselines, attempt counting, loss pauses, prompt versions, provider switching, reset/archive behavior, backup/restore, and the boundary for a future live adapter. Explain separate xAI billing and unknown usage fields.
- [ ] Run a live Binance smoke check for default instruments/rules, bid/ask sizes, candles, and connection health. Run exactly one bounded decision request for each configured AI provider, with a 90-second limit and no execution. If credentials/isolation are unavailable, record that provider as unverified; do not declare the provider or full acceptance complete.
- [ ] Follow README from a clean local setup and verify the browser workflow for live updates, prompts, controls, history, and reset. Run all automated checks and an independent final code review; resolve findings before publishing the final task.
- [ ] Review, commit, and push this task. Confirm `HEAD` equals `origin/main`, the worktree is clean, and no PR was created. Report implementation scope, validation evidence, and remaining external blockers.

## Final acceptance checklist

- [ ] All four source stages are complete, with one commit and immediate push per task.
- [ ] Exact accounting reconciles through partial/full sales, fees, rollback, concurrency, and restarts.
- [ ] Automatic/manual decisions cannot bypass risk, usage, pause, prompt/configuration versions, or active-simulation boundaries.
- [ ] Binance market data, retained history, valuation, SSE recovery, and dashboard workflows pass their checks.
- [ ] Both configured providers pass bounded live validation and secret/tool isolation checks; unconfigured/unverified providers are explicitly identified.
- [ ] Setup is reproducible; all required automated suites pass; final review findings are resolved.
- [ ] `main` is pushed, with no PR, force push, credentials, or assistant co-author attribution.

## Integration references and capability notes

- [Binance WebSocket documentation](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams): confirm stream behavior and limits when implementing Task 5.
- [Grok 4.3 model documentation](https://docs.x.ai/developers/models/grok-4.3): retain the requested configurable model; validate account access during the bounded smoke check.
- [Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [CLI reference](https://learn.chatgpt.com/docs/cli/reference): verify the actual invocation and effective isolation in Task 11.
- Local inspection on November 16, 2026 found `codex-cli 0.167.0-alpha.3.2`. Its `exec --help` lists `--json`, `--output-schema`, `--sandbox read-only`, `--ignore-user-config`, `--ignore-rules`, and `--ephemeral`. Help text says ignoring user configuration preserves the authentication location. These observations do **not** demonstrate that all tools, plugins, hooks, or connectors are disabled; Task 11 owns that proof.
