import type { ApprovedOrder, ExecutionProvider, ExecutionResult, Fill } from "@paper-investor/contracts";
import type { Pool } from "pg";
import type { MarketDataProvider } from "@paper-investor/contracts";
import { Decimal } from "decimal.js";
import { applyFillAccounting } from "../accounting/ledger.js";
import { assertQuoteFresh, validatePaperOrder } from "./validation.js";
import { evaluateRisk } from "../risk/evaluate.js";
import { enforceDailyLoss } from "../risk/daily-loss.js";

export class PaperExecutionProvider implements ExecutionProvider {
  constructor(private readonly pool: Pool, private readonly market: MarketDataProvider) {}

  async submit(order: ApprovedOrder, signal: AbortSignal): Promise<ExecutionResult> {
    await enforceDailyLoss(this.pool, order.simulationId);
    const instruments = await this.market.instruments(signal);
    const instrument = instruments.find((value) => value.symbol === order.symbol);
    if (!instrument) throw new Error("Instrument unavailable");
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const simulation = await client.query("SELECT status FROM simulations WHERE id=$1 FOR UPDATE", [order.simulationId]);
      const agent = await client.query("SELECT paused,generation,pause_reason FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [order.simulationId]);
      const config = await client.query("SELECT version,values FROM configurations WHERE simulation_id=$1 ORDER BY version DESC LIMIT 1", [order.simulationId]);
      if (simulation.rows[0]?.status !== "active" || agent.rows[0]?.generation !== order.runGeneration || config.rows[0]?.version !== order.configurationVersion) throw new Error("Order authorization expired");
      if (agent.rows[0]?.pause_reason === "daily_loss_limit") throw new Error("Daily loss pause is latched");
      const decision = await client.query("SELECT id FROM decisions WHERE id=$1 AND simulation_id=$2", [order.decisionId, order.simulationId]);
      if (decision.rowCount !== 1) throw new Error("Decision not found");
      const cashResult = await client.query("SELECT COALESCE(sum(amount),0)::text AS cash FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash','fee')", [order.simulationId]);
      const positions = await client.query("SELECT symbol,quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1 AND quantity<>0 FOR UPDATE", [order.simulationId]);
      const symbols = [...new Set([order.symbol, ...positions.rows.map((position) => position.symbol as string)])];
      const quoteResult = await client.query("SELECT DISTINCT ON(symbol) symbol,bid::text,ask::text,bid_size::text AS \"bidSize\",ask_size::text AS \"askSize\",observed_at AS \"observedAt\",received_at AS \"receivedAt\" FROM quote_samples WHERE symbol=ANY($1) ORDER BY symbol,received_at DESC", [symbols]);
      const quotes = new Map(quoteResult.rows.map((row) => [row.symbol as string, { ...row, observedAt: new Date(row.observedAt).toISOString(), receivedAt: new Date(row.receivedAt).toISOString() }]));
      const quote = quotes.get(order.symbol);
      if (!quote) throw new Error("Fresh quote unavailable");
      const settings = config.rows[0].values as Record<string, unknown>;
      const validated = validatePaperOrder({ side: order.side, quantity: order.quantity, instrument, quote, feeRate: String(settings.feeRate), slippageBps: Number(settings.slippageBps) });
      assertQuoteFresh(quote);
      const baseline = await client.query("SELECT equity::text FROM daily_baselines WHERE simulation_id=$1 AND utc_date=$2", [order.simulationId, new Date().toISOString().slice(0, 10)]);
      if (!baseline.rowCount) throw new Error("Daily loss baseline unavailable");
      const dailyLimit = Number(settings.dailyLossLimit);
      const currentEquity = new Decimal(cashResult.rows[0].cash).plus(positions.rows.reduce((total, position) => {
        const currentQuote = quotes.get(position.symbol as string);
        if (!currentQuote) throw new Error(`Fresh quote unavailable for ${position.symbol}`);
        assertQuoteFresh(currentQuote);
        return total.plus(new Decimal(position.quantity).mul(currentQuote.bid));
      }, new Decimal(0)));
      if (currentEquity.lte(new Decimal(baseline.rows[0].equity).mul(new Decimal(1).minus(dailyLimit)))) {
        await client.query("UPDATE agent_state SET paused=true,generation=generation+1,pause_reason='daily_loss_limit' WHERE simulation_id=$1", [order.simulationId]);
        await client.query("COMMIT");
        committed = true;
        throw new Error("Daily loss limit reached; pause latched");
      }
      const risk = evaluateRisk({ action: order.side, symbol: order.symbol, quantity: validated.quantity, cash: cashResult.rows[0].cash, positions: positions.rows.map((position) => ({ symbol: position.symbol as string, quantity: position.quantity as string })), bids: Object.fromEntries([...quotes].map(([symbol, row]) => [symbol, row.bid])), ask: quote.ask, bid: quote.bid, feeRate: String(settings.feeRate), slippageBps: Number(settings.slippageBps), maximumBuyPercent: String(settings.maximumBuyPercent), maximumAssetExposure: String(settings.maximumAssetExposure), maximumTotalExposure: String(settings.maximumTotalExposure) });
      if (!risk.allowed) throw new Error(`Risk rejected order: ${risk.reasonCode}`);
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
      await client.query("COMMIT");
      committed = true;
      return { status: "filled", orderId };
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async status(orderId: string) { const result = await this.pool.query("SELECT status FROM orders WHERE id=$1", [orderId]); if (!result.rowCount) throw new Error("Order not found"); return result.rows[0].status; }
  async fills(orderId: string): Promise<Fill[]> { const result = await this.pool.query("SELECT order_id AS \"orderId\",symbol,side,quantity::text,price::text,fee::text,created_at AS timestamp FROM fills WHERE order_id=$1", [orderId]); return result.rows; }
  async cancel(orderId: string) { const result = await this.pool.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='accepted'", [orderId]); return { cancelled: result.rowCount === 1 }; }
  async reconcile(simulationId: string) { const result = await this.pool.query("SELECT count(*)::int AS count FROM orders o LEFT JOIN fills f ON f.order_id=o.id WHERE o.simulation_id=$1 AND ((o.status='filled') <> (f.id IS NOT NULL))", [simulationId]); return { consistent: result.rows[0].count === 0 }; }
}
