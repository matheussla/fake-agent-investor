import { createDatabase } from "./db/client.js";
import { buildDecisionInput } from "./modules/decisions/context.js";
import { BinanceMarketDataProvider } from "./modules/market/ingestion.js";
import { checkCodexCapabilities } from "./providers/codex.js";
import { GrokDecisionProvider } from "./providers/grok.js";

const command = process.argv[2];

try {
  if (command === "binance") await smokeBinance();
  else if (command === "grok") await smokeGrok();
  else if (command === "codex") await smokeCodex();
  else throw new Error("Choose one smoke target: binance, grok, codex");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Smoke check failed");
  process.exitCode = 1;
}

async function smokeBinance(): Promise<void> {
  const provider = new BinanceMarketDataProvider();
  const signal = AbortSignal.timeout(15_000);
  const startTime = new Date(Date.now() - 5 * 60_000).toISOString();
  const endTime = new Date().toISOString();
  const [instruments, quote, candles] = await Promise.all([
    provider.instruments(signal),
    provider.quote("BTCUSDT", signal),
    provider.candles({ symbol: "BTCUSDT", interval: "1m", startTime, endTime }, signal),
  ]);
  const bitcoin = instruments.find((instrument) => instrument.symbol === "BTCUSDT" && instrument.status === "trading");
  if (!bitcoin || Number(quote.bid) <= 0 || Number(quote.ask) < Number(quote.bid) || candles.length === 0) {
    throw new Error("Binance smoke check returned missing or invalid BTC/USDT market data");
  }
  console.log(`PASS Binance public market data: ${instruments.length} USDT instruments, BTCUSDT bid/ask available, ${candles.length} recent candles.`);
  console.log("No WebSocket subscription or order was opened.");
}

async function smokeGrok(): Promise<void> {
  if (!process.env.XAI_API_KEY) {
    console.log("SKIP Grok smoke check: XAI_API_KEY is not configured. No request was sent.");
    return;
  }

  const { pool } = createDatabase();
  try {
    const active = await pool.query("SELECT id FROM simulations WHERE status='active' LIMIT 1");
    const simulationId = active.rows[0]?.id as string | undefined;
    if (!simulationId) throw new Error("Start PostgreSQL and apply migrations before the Grok smoke check");
    const input = await buildDecisionInput(pool, simulationId);
    if (input.market.length === 0 || input.market.some((quote) => Date.now() - Date.parse(quote.receivedAt) > 60_000)) {
      throw new Error("Grok smoke check requires fresh market quotes; start the app and wait for Binance data");
    }
    const startedAt = Date.now();
    const result = await new GrokDecisionProvider(process.env.XAI_API_KEY).decide(input, AbortSignal.timeout(30_000));
    console.log(`PASS Grok bounded decision request: action=${result.decision.action}, latency=${Date.now() - startedAt}ms, inputTokens=${result.usage?.inputTokens ?? "unknown"}, outputTokens=${result.usage?.outputTokens ?? "unknown"}.`);
    console.log("The decision was validated and discarded. No order was created or submitted.");
  } finally {
    await pool.end();
  }
}

async function smokeCodex(): Promise<void> {
  const health = await checkCodexCapabilities();
  if (health.status === "healthy") {
    console.log("Codex isolation capability check passed, but this smoke command does not make a model request.");
    return;
  }
  console.log(`SKIP Codex model request: ${health.detail}. No model request or order was sent.`);
}
