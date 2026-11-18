import { useEffect, useRef } from "react";
import { createChart, LineSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { formatPrice } from "../../lib/format.js";
import type { EquityPoint } from "../../lib/api.js";

export function EquityChart({ points }: { points: EquityPoint[] }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const chart = createChart(element, { autoSize: true, layout: { background: { color: "#10151a" }, textColor: "#93a2ad" }, grid: { vertLines: { color: "#202a31" }, horzLines: { color: "#202a31" } }, rightPriceScale: { borderColor: "#26343e" }, timeScale: { borderColor: "#26343e", timeVisible: true } });
    const series = chart.addSeries(LineSeries, { color: "#5ee0b5", lineWidth: 2, priceLineVisible: false });
    chartRef.current = chart; seriesRef.current = series;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; fitted.current = false; };
  }, []);
  useEffect(() => {
    const chart = chartRef.current; const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(points.map((point) => ({ time: Math.floor(Date.parse(point.observed_at) / 1000) as UTCTimestamp, value: Number(point.equity) })).filter((point) => Number.isFinite(point.value)));
    if (points.length && !fitted.current) { chart.timeScale().fitContent(); fitted.current = true; }
  }, [points]);
  const first = points[0]?.equity;
  const latest = points.at(-1)?.equity;
  return <section className="panel chart-panel" aria-labelledby="equity-chart-heading"><div className="panel-heading"><div><p className="eyebrow">ACCOUNT VALUE</p><h2 id="equity-chart-heading">Equity history</h2></div><span className="muted">USD stablecoin</span></div><div ref={container} className="chart" role="img" aria-label="Paper portfolio equity chart"/><p className="chart-summary">{points.length ? `Chart summary: ${points.length} observations, from ${formatPrice(first!)} to ${formatPrice(latest!)} USDT.` : "No equity observations yet."}</p></section>;
}
