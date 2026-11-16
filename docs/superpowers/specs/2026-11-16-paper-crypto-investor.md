# Paper Crypto Investor with Grok and Codex

## Summary

Build a local application that invests virtual funds using real Binance prices. Select Grok or Codex as the investor, supply strategy prompts, and monitor live balances, positions, and decisions.

Use TypeScript, React, a persistent Node.js backend, and PostgreSQL. Follow the reference image’s dark trading-terminal style.

Version one supports one active portfolio and one selected provider. Trading is automatic within configurable limits. Real-money execution remains a separate future integration.

## Architecture and integrations

Use a modular monolith: one backend with clear boundaries, shared contracts, and replaceable adapters.

- **Frontend:** React, Vite, Tailwind, and TradingView Lightweight Charts.
- **Backend:** Fastify with market ingestion, agent scheduling, risk validation, execution, and accounting modules.
- **Database:** PostgreSQL with Drizzle migrations. Use `decimal.js` and database `NUMERIC` fields for monetary calculations; serialize amounts as decimal strings.
- **Local runtime:** Run Node.js directly on your Mac and PostgreSQL through Docker Compose. Bind the application to localhost and enforce same-origin requests.

Define three integration contracts:

- **`MarketDataProvider`:** Instruments, trading rules, quotes, candles, and connection health.
- **`DecisionProvider`:** Accepts a portfolio snapshot, market context, limits, and strategy prompt. Returns a validated buy, sell, or hold decision with a concise explanation.
- **`ExecutionProvider`:** Submits orders and exposes order status and fills, with cancellation and reconciliation boundaries for future exchange adapters.

Initial adapters:

- **Binance market data:** Public production WebSocket streams for bid/ask prices, ticker statistics, and one-minute candles. Bootstrap history and instrument rules through public REST endpoints. Handle heartbeat, reconnection, duplicate messages, and candle gaps. [Binance documentation](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams).
- **Grok:** Use `ai` and `@ai-sdk/xai` with structured output. Keep `XAI_API_KEY` server-side. Default to configurable `grok-4.3`. API billing remains separate from the simulated portfolio. [Model documentation](https://docs.x.ai/developers/models/grok-4.3).
- **Codex:** Invoke the installed CLI using its existing ChatGPT login, JSON output, and an output schema. Use an isolated working directory, restricted environment, read-only permissions, and disabled execution tools, plugins, hooks, and external connectors. Do not modify the user’s Codex configuration or copy credentials. [Codex automation documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
- **Paper execution:** The only execution adapter enabled in version one. Neither model receives database access or permission to execute trades directly.

A future live adapter will require authenticated exchange access, asynchronous fill reconciliation, and a separate enablement workflow.

## Trading, accounting, and persistence

**Configurable starting defaults**

- 10,000 virtual USDT.
- BTC/USDT, ETH/USDT, and SOL/USDT.
- Spot purchases and sales; no borrowing, leverage, or short positions.
- One decision every five minutes, with at most one order per decision.
- Maximum buy size: 10% of equity; maximum asset exposure: 25%; maximum total exposure: 50%.
- A 5% daily equity loss pauses execution without liquidating positions. Persist the daily baseline and require explicit resume after the condition clears or limits change.

**Simulated execution**

- Buy at the current ask plus five basis points of slippage; sell at the bid minus five basis points.
- Charge a configurable simulated fee, initially 0.1% per side.
- Validate available funds, holdings, exchange quantity increments, applicable notional limits, and displayed quote size.
- Use complete fills only. Reject unsupported sizes and stale prices; refresh quotes before execution when needed.
- Label fees, slippage, and fill behavior as simulation assumptions.

**Accounting**

- Record initial funding, orders, fills, fees, and balance movements in an immutable ledger.
- Commit each fill, ledger update, and position update atomically.
- Use weighted-average acquisition cost, including purchase fees. Include sale fees in realized profit.
- Calculate equity as virtual cash plus holdings valued at current bids.
- Show realized profit, unrealized profit, total profit, cash, and exposure separately.
- Calculate win rate and average realized profit from sell executions, with that basis visible.

**Stored data**

Persist portfolios, configuration versions, prompt versions, decisions, input snapshots, orders, fills, ledger entries, positions, equity history, market data, and operational events.

Retain one-second quote samples for 24 hours and closed candles for 90 days. Keep decision evidence, trade records, and minute equity snapshots with each simulation. Store timestamps in UTC.

**Agent lifecycle**

- Start paused. Provide Start, Pause, and Run Once.
- Continue market updates and valuation while paused.
- Prevent overlapping cycles and duplicate fills using database locking, configuration versions, and unique decision identifiers.
- Apply a 90-second decision timeout and a default limit of 300 attempts per UTC day.
- Record failures without placing a trade. Pause after three consecutive provider failures or exhausted usage allowance.
- Cancel pending decisions when paused and reject late responses.
- Restart paused and never execute missed cycles after downtime.

## Dashboard, prompts, and API

Build the dashboard around the reference image:

- Persistent **PAPER TRADING** indicator and active provider.
- Equity, available cash, profit, exposure, and performance cards.
- Live equity curve, market candlesticks, positions, and trade history.
- Activity feed showing market ingestion, decisions, risk checks, fills, and failures.
- Actual module health, data freshness, and provider usage.
- Responsive layout with readable text and keyboard-accessible controls.

Add a strategy prompt editor with named prompts, saved versions, and activation. Each decision records its exact prompt version and market context. Newly activated prompts apply to the next cycle; an existing cycle retains its original version.

Allow provider, model, assets, cadence, and risk settings to change while paused. Prevent removal of assets still held. Switching Grok/Codex preserves balances and history. Resetting creates a new simulation and archives the previous one.

Expose validated local APIs for:

- Reading portfolio totals, positions, equity history, markets, trades, decisions, prompts, settings, and health.
- Starting, pausing, and running one agent cycle.
- Saving and activating prompts, updating settings, and creating a new simulation.
- Streaming market, portfolio, decision, execution, and status updates through SSE.

Throttle display updates to once per second and reload authoritative state after reconnection. Show unavailable or stale data explicitly.

## Implementation and validation

Implement in four stages:

1. Database migrations, decimal accounting, and deterministic paper execution.
2. Binance ingestion, retained market history, portfolio valuation, and SSE.
3. Grok and Codex adapters, prompts, scheduler, and risk enforcement.
4. Dashboard, setup instructions, integration checks, and final review.

Use Vitest and PostgreSQL integration tests to verify:

- Fees, rounding, partial position sales, and realized/unrealized profit reconciliation.
- Insufficient funds, unsupported quantities, exposure limits, and stale quotes.
- Duplicate decisions, concurrent execution, transaction rollback, and restart recovery.
- Invalid model responses, timeouts, quota failures, and prompt attempts to bypass limits.
- Pause during a decision, prompt activation, and provider switching.
- Secret isolation and rejection of unauthorized browser origins.

Verify the browser workflow for setup, live updates, prompts, Start/Pause/Run Once, history, and reset. Run a live Binance smoke test and one bounded decision request for each configured AI provider.

Setup requires a running Docker daemon, an xAI API key for Grok, and a valid local Codex login. Docker is installed but currently not running. No application files have been created during planning.
