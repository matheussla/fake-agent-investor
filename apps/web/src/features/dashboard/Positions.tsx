import type { PortfolioData } from "../../lib/api.js";

export function Positions({ portfolio }: { portfolio: PortfolioData | null }) {
  return <section className="panel" aria-labelledby="positions-heading"><div className="panel-heading"><div><p className="eyebrow">OPEN EXPOSURE</p><h2 id="positions-heading">Positions</h2></div><span className="muted">{portfolio?.positions.length ?? 0} assets</span></div><div className="table-wrap"><table><thead><tr><th scope="col">Asset</th><th scope="col">Quantity</th><th scope="col">Cost basis</th></tr></thead><tbody>{portfolio?.positions.length ? portfolio.positions.map((position) => <tr key={position.symbol}><th scope="row">{position.symbol}</th><td>{position.quantity}</td><td>{position.cost_basis} USDT</td></tr>) : <tr><td colSpan={3} className="empty">No open positions</td></tr>}</tbody></table></div></section>;
}
