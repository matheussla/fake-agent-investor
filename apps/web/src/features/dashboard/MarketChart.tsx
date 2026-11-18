import { useEffect, useRef, type ReactNode } from "react";
import { CandlestickSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { formatPrice } from "../../lib/format.js";
import type { CandleRow } from "../../lib/api.js";

export function MarketChart({ symbol, candles, picker, loading = false, error = "" }: { symbol: string; candles: CandleRow[]; picker?: ReactNode; loading?: boolean; error?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fittedSymbol = useRef("");
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const chart = createChart(element, { autoSize: true, layout: { background: { color: "#10151a" }, textColor: "#93a2ad" }, grid: { vertLines: { color: "#202a31" }, horzLines: { color: "#202a31" } }, rightPriceScale: { borderColor: "#26343e" }, timeScale: { borderColor: "#26343e", timeVisible: true } });
    const series = chart.addSeries(CandlestickSeries, { upColor: "#5ee0b5", downColor: "#fc7580", borderVisible: false, wickUpColor: "#5ee0b5", wickDownColor: "#fc7580" });
    chartRef.current = chart; seriesRef.current = series;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; fittedSymbol.current = ""; };
  }, []);
  useEffect(() => {
    const chart = chartRef.current; const series = seriesRef.current;
    if (!chart || !series) return;
    const precision = Math.max(2, ...candles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close].map((price) => Math.min(8, (price.replace(/0+$/, "").split(".")[1] ?? "").length))));
    series.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
    series.setData(candles.map((candle) => ({ time: Math.floor(Date.parse(candle.openTime) / 1000) as UTCTimestamp, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close) })).filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)));
    if (candles.length && fittedSymbol.current !== symbol) { chart.timeScale().fitContent(); fittedSymbol.current = symbol; }
  }, [candles, symbol]);
  const latest = candles.at(-1);
  return <section className="panel chart-panel" aria-labelledby="market-chart-heading"><div className="panel-heading"><div><p className="eyebrow">MARKET TAPE</p><h2 id="market-chart-heading">{symbol} · 1 minute</h2></div>{picker ?? <span className="muted">Binance spot</span>}</div><div ref={container} className="chart" role="img" aria-label={`${symbol} candlestick chart`}/><p className="chart-summary">{latest ? `Latest candle: open ${formatPrice(latest.open)}, high ${formatPrice(latest.high)}, low ${formatPrice(latest.low)}, close ${formatPrice(latest.close)} USDT.` : loading ? "Loading market candles…" : "No closed candles available."}</p>{error && <p className="form-error" role="alert">{error}</p>}</section>;
}
