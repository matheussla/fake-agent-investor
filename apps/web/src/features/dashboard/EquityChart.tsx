import { useEffect, useRef } from "react";
import { createChart, LineSeries, type UTCTimestamp } from "lightweight-charts";
import type { EquityPoint } from "../../lib/api.js";

export function EquityChart({ points }: { points: EquityPoint[] }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const chart = createChart(element, { autoSize: true, layout: { background: { color: "#10151a" }, textColor: "#93a2ad" }, grid: { vertLines: { color: "#202a31" }, horzLines: { color: "#202a31" } }, rightPriceScale: { borderColor: "#26343e" }, timeScale: { borderColor: "#26343e", timeVisible: true } });
    const series = chart.addSeries(LineSeries, { color: "#5ee0b5", lineWidth: 2, priceLineVisible: false });
    series.setData(points.map((point) => ({ time: Math.floor(Date.parse(point.observed_at) / 1000) as UTCTimestamp, value: Number(point.equity) })).filter((point) => Number.isFinite(point.value)));
    if (points.length) chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  const first = points[0]?.equity;
  const latest = points.at(-1)?.equity;
  return <section className="panel chart-panel" aria-labelledby="equity-chart-heading"><div className="panel-heading"><div><p className="eyebrow">ACCOUNT VALUE</p><h2 id="equity-chart-heading">Equity history</h2></div><span className="muted">USD stablecoin</span></div><div ref={container} className="chart" role="img" aria-label="Paper portfolio equity chart"/><p className="chart-summary">{points.length ? `Chart summary: ${points.length} observations, from ${first} to ${latest} USDT.` : "No equity observations yet."}</p></section>;
}
