import { useEffect, useState } from "react";
import { api, type CandleRow } from "../../lib/api.js";
import { MarketChart } from "./MarketChart.js";
import { MarketPicker, type MarketSymbol } from "./MarketPicker.js";

export function MarketBrowser({ active }: { active: boolean }) {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [markets, setMarkets] = useState<MarketSymbol[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [history, setHistory] = useState<{ symbol: string; candles: CandleRow[] }>({ symbol: "BTCUSDT", candles: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setCatalogLoading(true); setCatalogError("");
      try {
        const data = await api<MarketSymbol[]>("/api/market-symbols", AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (!controller.signal.aborted) setMarkets(data);
      } catch {
        if (!controller.signal.aborted) {
          setCatalogError("Could not load Binance markets. Retrying automatically…");
          retryTimer = setTimeout(() => void load(), 5000);
        }
      }
      finally { if (!controller.signal.aborted) setCatalogLoading(false); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(retryTimer); };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const candles = await api<CandleRow[]>(`/api/market-candles?symbol=${encodeURIComponent(symbol)}`, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (!controller.signal.aborted) { setHistory({ symbol, candles }); setError(""); }
      } catch { if (!controller.signal.aborted) setError(`Could not load ${symbol} candles. Retrying automatically…`); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    setLoading(true); setError("");
    void load();
    const poll = setInterval(() => void load(), 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); };
  }, [active, symbol]);

  return <MarketChart symbol={symbol} candles={history.symbol === symbol ? history.candles : []} loading={loading} error={error} picker={<MarketPicker markets={markets} symbol={symbol} loading={catalogLoading} error={catalogError} onSelect={setSymbol}/>}/>;
}
