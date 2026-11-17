import { useEffect, useRef } from "react";
import { CandlestickSeries, createChart, type UTCTimestamp } from "lightweight-charts";
import type { CandleRow } from "../../lib/api.js";

export function MarketChart({ symbol, candles }: { symbol: string; candles: CandleRow[] }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const chart = createChart(element, { autoSize: true, layout: { background: { color: "#10151a" }, textColor: "#93a2ad" }, grid: { vertLines: { color: "#202a31" }, horzLines: { color: "#202a31" } }, rightPriceScale: { borderColor: "#26343e" }, timeScale: { borderColor: "#26343e", timeVisible: true } });
    const series = chart.addSeries(CandlestickSeries, { upColor: "#5ee0b5", downColor: "#fc7580", borderVisible: false, wickUpColor: "#5ee0b5", wickDownColor: "#fc7580" });
    series.setData(candles.map((candle) => ({ time: Math.floor(Date.parse(candle.openTime) / 1000) as UTCTimestamp, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close) })).filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)));
    if (candles.length) chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles]);
  const latest = candles.at(-1);
  return <section className="panel chart-panel" aria-labelledby="market-chart-heading"><div className="panel-heading"><div><p className="eyebrow">MARKET TAPE</p><h2 id="market-chart-heading">{symbol} · 1 minute</h2></div><span className="muted">Binance spot</span></div><div ref={container} className="chart" role="img" aria-label={`${symbol} candlestick chart`}/><p className="chart-summary">{latest ? `Latest candle: open ${latest.open}, high ${latest.high}, low ${latest.low}, close ${latest.close} USDT.` : "No closed candles available."}</p></section>;
}
