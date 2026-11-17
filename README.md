# Paper Crypto Investor

A local paper trading app that uses live Binance spot market data and a configurable Grok decision provider. The app only simulates orders; it has no live trading adapter.

## Requirements

- macOS or Linux
- Node.js 24.11.1 (see `.node-version`)
- pnpm 10
- Docker with Docker Compose
- An xAI API key to request Grok decisions

Codex CLI decisions remain disabled because the installed CLI cannot prove that its command tool is isolated. The app never modifies Codex configuration or copies Codex credentials.

## Start locally

```sh
pnpm install
cp .env.example .env
```

Set `XAI_API_KEY` in `.env` to enable Grok. The server reads this file at startup. Keep `.env` private; it is ignored by Git.

Start PostgreSQL and apply the schema:

```sh
pnpm db:up
pnpm db:migrate
```

Start the local API and web app:

```sh
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API binds to `127.0.0.1:3000`. On first run, open Settings and choose the starting virtual USDT balance. That balance stays fixed for the simulation; choose a new balance only when resetting it. Configure trading settings and a strategy prompt, save while the agent is paused, then start or pause the agent from Settings. The app continues market ingestion and valuation while the agent is paused.

To stop PostgreSQL, run `pnpm db:down`. Its Docker volume is retained.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | API bind address. Other bind addresses are rejected. |
| `PORT` | `3000` | API port. |
| `DATABASE_URL` | `postgres://paper:paper@127.0.0.1:5433/paper_investor` | PostgreSQL connection. |
| `XAI_API_KEY` | unset | Server-side Grok API credential. |

The initial strategy watches BTC/USDT, ETH/USDT, and SOL/USDT, with a five-minute decision cadence. Risk defaults cap a buy at 10% of equity, a single asset at 25%, total exposure at 50%, and daily equity loss at 5%. Fees and slippage are simulated settings. Grok decisions are validated before they can reach paper execution.

API and dashboard controls are local and same-origin only. Do not expose the app to a public network.

## Smoke checks

These checks never submit orders:

```sh
pnpm smoke:binance
pnpm smoke:grok
pnpm smoke:codex
```

- `smoke:binance` makes bounded public REST requests for exchange instruments, one BTC/USDT quote, and recent one-minute candles.
- `smoke:grok` sends at most one validated decision request using the active simulation and fresh quotes, then discards the decision. It requires `XAI_API_KEY`, a migrated database, and a running app to populate market data. Without a key, it reports a skip without sending a request. The request has a 30-second deadline.
- `smoke:codex` checks CLI isolation capabilities only. It does not make a model request. The Codex provider stays disabled unless isolation can be demonstrated.

The smoke scripts print request results and decisions without printing credentials, prompts, or portfolio snapshots.

## Validation

Start Docker first, then use the isolated test database:

```sh
pnpm db:up
pnpm db:migrate:test
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
```

See [docs/validation.md](docs/validation.md) for coverage and system validation details. Integration tests truncate data in `paper_investor_test`; they do not use the application database.
