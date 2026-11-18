import type { ApprovedOrder, ExecutionProvider, ExecutionResult, Fill } from "@paper-investor/contracts";
import type { Pool, PoolClient } from "pg";
import type { MarketDataProvider } from "@paper-investor/contracts";
import { Decimal } from "decimal.js";
import { applyFillAccounting } from "../accounting/ledger.js";
import { assertQuoteFresh, decisionMarketRejection, validatePaperOrder } from "./validation.js";
import { evaluateRisk } from "../risk/evaluate.js";
import { latchDailyLoss } from "../risk/daily-loss.js";
import { recordDailyBaseline } from "../portfolio/valuation.js";
import { latestQuotes } from "../market/latest-quotes.js";
import { withSimulationTransaction } from "../../db/simulation-transaction.js";

export class PaperExecutionProvider implements ExecutionProvider {
  constructor(private readonly pool: Pool, private readonly market: MarketDataProvider) {}

  async submit(order: ApprovedOrder, signal: AbortSignal): Promise<ExecutionResult> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    deadline.throwIfAborted();
    const prior = await this.existingOrder(this.pool, order);
    if (prior) return prior;
    const instruments = await this.market.instruments(deadline);
    deadline.throwIfAborted();
    const instrument = instruments.find((value) => value.symbol === order.symbol);
    if (!instrument) throw new Error("Instrument unavailable");
    return withSimulationTransaction(this.pool, order.simulationId, async (client, simulation) => {
      const existingOrder = await this.existingOrder(client, order);
      if (existingOrder) return existingOrder;
      const agent = await client.query("SELECT paused,generation,pause_reason FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [order.simulationId]);
      const config = await client.query("SELECT version,values FROM configurations WHERE simulation_id=$1 ORDER BY version DESC LIMIT 1", [order.simulationId]);
      if (simulation.status !== "active" || agent.rows[0]?.generation !== order.runGeneration || config.rows[0]?.version !== order.configurationVersion) throw new Error("Order authorization expired");
      if (agent.rows[0]?.pause_reason === "daily_loss_limit") return this.rejectOrder(client, order, "DAILY_LOSS_LIMIT");
      const decision = await client.query("SELECT id,created_at FROM decisions WHERE id=$1 AND simulation_id=$2 AND run_generation=$3 AND configuration_version=$4", [order.decisionId, order.simulationId, order.runGeneration, order.configurationVersion]);
      if (decision.rowCount !== 1) throw new Error("Decision not found");
      const cashResult = await client.query("SELECT COALESCE(sum(amount),0)::text AS cash FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash','fee')", [order.simulationId]);
      const positions = await client.query("SELECT symbol,quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1 AND quantity<>0 FOR UPDATE", [order.simulationId]);
      const symbols = [...new Set([order.symbol, ...positions.rows.map((position) => position.symbol as string)])];
      const quotes = new Map(symbols.flatMap((symbol) => {
        const live = this.market.cachedQuote?.(symbol);
        return live ? [[symbol, live] as const] : [];
      }));
      for (const sampled of await latestQuotes(client, symbols.filter((symbol) => !quotes.has(symbol)))) quotes.set(sampled.symbol, sampled);
      const quote = quotes.get(order.symbol);
      if (!quote) throw new Error("Fresh quote unavailable");
      const settings = config.rows[0].values as Record<string, unknown>;
      const maximumAge = Number(settings.maximumDecisionAgeSeconds ?? 60);
      const maximumMovement = Number(settings.maximumPriceMovementBps ?? 50);
      const marketRejection = decisionMarketRejection(order, quote, decision.rows[0].created_at, maximumAge, maximumMovement);
      if (marketRejection) return this.rejectOrder(client, order, marketRejection);
      const validated = validatePaperOrder({ side: order.side, quantity: order.quantity, instrument, quote, feeRate: String(settings.feeRate), slippageBps: Number(settings.slippageBps) });
      assertQuoteFresh(quote);
      const currentEquity = new Decimal(cashResult.rows[0].cash).plus(positions.rows.reduce((total, position) => {
        const currentQuote = quotes.get(position.symbol as string);
        if (!currentQuote) throw new Error(`Fresh quote unavailable for ${position.symbol}`);
        assertQuoteFresh(currentQuote);
        return total.plus(new Decimal(position.quantity).mul(currentQuote.bid));
      }, new Decimal(0)));
      const valuationTime = new Date();
      await recordDailyBaseline(client, order.simulationId, currentEquity.toFixed(), valuationTime);
      if (await latchDailyLoss(client, order.simulationId, currentEquity.toFixed(), valuationTime)) return this.rejectOrder(client, order, "DAILY_LOSS_LIMIT");
      const risk = evaluateRisk({ action: order.side, symbol: order.symbol, quantity: validated.quantity, cash: cashResult.rows[0].cash, positions: positions.rows.map((position) => ({ symbol: position.symbol as string, quantity: position.quantity as string })), bids: Object.fromEntries([...quotes].map(([symbol, row]) => [symbol, row.bid])), ask: quote.ask, bid: quote.bid, feeRate: String(settings.feeRate), slippageBps: Number(settings.slippageBps), maximumBuyPercent: String(settings.maximumBuyPercent), maximumAssetExposure: String(settings.maximumAssetExposure), maximumTotalExposure: String(settings.maximumTotalExposure) });
      if (!risk.allowed) return this.rejectOrder(client, order, risk.reasonCode ?? "INVALID_AMOUNT");
      deadline.throwIfAborted();
      const existing = positions.rows.find((position) => position.symbol === order.symbol);
      const accounting = applyFillAccounting({ side: order.side, quantity: validated.quantity, price: validated.price, fee: validated.fee, cash: cashResult.rows[0].cash, positionQuantity: existing?.quantity ?? "0", costBasis: existing?.cost_basis ?? "0" });
      const inserted = await client.query("INSERT INTO orders(simulation_id,decision_id,symbol,side,quantity,status) VALUES($1,$2,$3,$4,$5,'accepted') RETURNING id", [order.simulationId, order.decisionId, order.symbol, order.side, validated.quantity]);
      const orderId = inserted.rows[0].id as string;
      const fill = await client.query("INSERT INTO fills(order_id,simulation_id,symbol,side,quantity,price,fee) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [orderId, order.simulationId, order.symbol, order.side, validated.quantity, validated.price, validated.fee]);
      const cashMovement = order.side === "buy" ? new Decimal(validated.notional).negated() : new Decimal(validated.notional);
      await client.query("INSERT INTO ledger_entries(simulation_id,fill_id,asset,amount,kind) VALUES($1,$2,'USDT',$3,'trade_cash'),($1,$2,$4,$5,'asset_movement'),($1,$2,'USDT',$6,'fee')", [order.simulationId, fill.rows[0].id, cashMovement.toFixed(), instrument.baseAsset, order.side === "buy" ? validated.quantity : `-${validated.quantity}`, `-${validated.fee}`]);
      await client.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) VALUES($1,$2,$3,$4) ON CONFLICT(simulation_id,symbol) DO UPDATE SET quantity=EXCLUDED.quantity,cost_basis=EXCLUDED.cost_basis,created_at=now()", [order.simulationId, order.symbol, accounting.positionQuantity, accounting.costBasis]);
      if (order.side === "sell") await client.query("INSERT INTO ledger_entries(simulation_id,fill_id,asset,amount,kind) VALUES($1,$2,'USDT',$3,'realized_profit')", [order.simulationId, fill.rows[0].id, accounting.realizedProfit]);
      await client.query("UPDATE orders SET status='filled' WHERE id=$1", [orderId]);
      deadline.throwIfAborted();
      for (const currentQuote of quotes.values()) assertQuoteFresh(currentQuote);
      const expired = decisionMarketRejection(order, quote, decision.rows[0].created_at, maximumAge, maximumMovement);
      if (expired) throw new Error(expired);
      return { status: "filled", orderId };
    }, deadline);
  }

  private async existingOrder(database: Pool | PoolClient, order: ApprovedOrder): Promise<ExecutionResult | undefined> {
    const result = await database.query("SELECT o.id,o.simulation_id,o.symbol,o.side,o.quantity::text,o.status,o.reason,d.run_generation,d.configuration_version FROM orders o JOIN decisions d ON d.id=o.decision_id WHERE o.decision_id=$1", [order.decisionId]);
    const existing = result.rows[0];
    if (!existing) return;
    if (existing.simulation_id !== order.simulationId || existing.symbol !== order.symbol || existing.side !== order.side || !new Decimal(existing.quantity).eq(order.quantity) || existing.run_generation !== order.runGeneration || existing.configuration_version !== order.configurationVersion) throw new Error("Idempotency conflict");
    if (existing.status !== "filled" && existing.status !== "rejected") throw new Error("Order outcome requires reconciliation");
    return { status: existing.status, orderId: existing.id, ...(existing.reason ? { reason: existing.reason } : {}) };
  }

  private async rejectOrder(client: PoolClient, order: ApprovedOrder, reason: string): Promise<ExecutionResult> {
    const result = await client.query("INSERT INTO orders(simulation_id,decision_id,symbol,side,quantity,status,reason) VALUES($1,$2,$3,$4,$5,'rejected',$6) RETURNING id", [order.simulationId, order.decisionId, order.symbol, order.side, order.quantity, reason]);
    return { status: "rejected", orderId: result.rows[0].id, reason };
  }

  async status(orderId: string) { const result = await this.pool.query("SELECT status FROM orders WHERE id=$1", [orderId]); if (!result.rowCount) throw new Error("Order not found"); return result.rows[0].status; }
  async fills(orderId: string): Promise<Fill[]> { const result = await this.pool.query("SELECT order_id AS \"orderId\",symbol,side,quantity::text,price::text,fee::text,created_at AS timestamp FROM fills WHERE order_id=$1", [orderId]); return result.rows; }
  async cancel(orderId: string) { const result = await this.pool.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='accepted'", [orderId]); return { cancelled: result.rowCount === 1 }; }
  async reconcile(simulationId: string) { const result = await this.pool.query("SELECT count(*)::int AS count FROM orders o LEFT JOIN fills f ON f.order_id=o.id WHERE o.simulation_id=$1 AND ((o.status='filled') <> (f.id IS NOT NULL))", [simulationId]); return { consistent: result.rows[0].count === 0 }; }
}
