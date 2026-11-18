import type { Pool, PoolClient } from "pg";
import type { Quote } from "@paper-investor/contracts";

type QuoteRow = Omit<Quote, "observedAt" | "receivedAt"> & { observedAt: Date; receivedAt: Date };

export async function latestQuotes(database: Pool | PoolClient, symbols: string[], before?: string): Promise<Quote[]> {
  if (!symbols.length) return [];
  const result = await database.query<QuoteRow>(`SELECT latest.symbol, latest.bid::text, latest.ask::text,
    latest.bid_size::text AS "bidSize", latest.ask_size::text AS "askSize",
    latest.observed_at AS "observedAt", latest.received_at AS "receivedAt"
    FROM unnest($1::text[]) AS requested(symbol)
    CROSS JOIN LATERAL (
      SELECT * FROM quote_samples WHERE symbol=requested.symbol ${before ? "AND observed_at < $2::timestamptz" : ""} ORDER BY received_at DESC NULLS LAST LIMIT 1
    ) latest`, before ? [[...new Set(symbols)], before] : [[...new Set(symbols)]]);
  return result.rows.map((quote) => ({ ...quote, observedAt: quote.observedAt.toISOString(), receivedAt: quote.receivedAt.toISOString() }));
}
