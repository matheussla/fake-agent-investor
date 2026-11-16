import type { ApprovedOrder, ExecutionProvider, ExecutionResult, Fill } from "@paper-investor/contracts";
import type { Pool } from "pg";
import type { MarketDataProvider } from "@paper-investor/contracts";
import { Decimal } from "decimal.js";
import { applyFillAccounting } from "../accounting/ledger.js";
import { assertQuoteFresh, validatePaperOrder } from "./validation.js";

export class PaperExecutionProvider implements ExecutionProvider {
  constructor(private readonly pool: Pool, private readonly market: MarketDataProvider) {}

  async submit(order: ApprovedOrder, signal: AbortSignal): Promise<ExecutionResult> {
    const instruments = await this.market.instruments(signal);
    const instrument = instruments.find((value) => value.symbol === order.symbol);
    if (!instrument) throw new Error("Instrument unavailable");
    const quote = await this.market.quote(order.symbol, signal);
    const validated = validatePaperOrder({ side: order.side, quantity: order.quantity, instrument, quote });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const simulation = await client.query("SELECT status FROM simulations WHERE id=$1 FOR UPDATE", [order.simulationId]);
      const agent = await client.query("SELECT paused,generation FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [order.simulationId]);
      const config = await client.query("SELECT version FROM configurations WHERE simulation_id=$1 ORDER BY version DESC LIMIT 1", [order.simulationId]);
      if (simulation.rows[0]?.status !== "active" || agent.rows[0]?.generation !== order.runGeneration || config.rows[0]?.version !== order.configurationVersion) throw new Error("Order authorization expired");
      assertQuoteFresh(quote);
      const decision = await client.query("SELECT id FROM decisions WHERE id=$1 AND simulation_id=$2", [order.decisionId, order.simulationId]);
      if (decision.rowCount !== 1) throw new Error("Decision not found");
      const cashResult = await client.query("SELECT COALESCE(sum(amount),0)::text AS cash FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash','fee')", [order.simulationId]);
      const [existing] = (await client.query("SELECT quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1 AND symbol=$2 FOR UPDATE", [order.simulationId, order.symbol])).rows;
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
      return { status: "filled", orderId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async status(orderId: string) { const result = await this.pool.query("SELECT status FROM orders WHERE id=$1", [orderId]); if (!result.rowCount) throw new Error("Order not found"); return result.rows[0].status; }
  async fills(orderId: string): Promise<Fill[]> { const result = await this.pool.query("SELECT order_id AS \"orderId\",symbol,side,quantity::text,price::text,fee::text,created_at AS timestamp FROM fills WHERE order_id=$1", [orderId]); return result.rows; }
  async cancel(orderId: string) { const result = await this.pool.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='accepted'", [orderId]); return { cancelled: result.rowCount === 1 }; }
  async reconcile(simulationId: string) { const result = await this.pool.query("SELECT count(*)::int AS count FROM orders o LEFT JOIN fills f ON f.order_id=o.id WHERE o.simulation_id=$1 AND ((o.status='filled') <> (f.id IS NOT NULL))", [simulationId]); return { consistent: result.rows[0].count === 0 }; }
}
