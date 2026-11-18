import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface MarketSymbol { symbol: string; baseAsset: string; quoteAsset: string; }

export function MarketPicker({ markets, symbol, loading, error, onSelect }: { markets: MarketSymbol[]; symbol: string; loading: boolean; error: string; onSelect: (symbol: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const filtered = useMemo(() => {
    const term = query.toUpperCase().replace(/[\s/\-]/g, "");
    const rank = (market: MarketSymbol) => market.baseAsset === term || market.symbol === term ? 0 : market.symbol.startsWith(term) ? 1 : 2;
    return markets.filter((market) => market.symbol.includes(term) || market.baseAsset.includes(term)).sort((a, b) => rank(a) - rank(b));
  }, [markets, query]);
  const matches = filtered.slice(0, 80);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const select = (value: string) => { onSelect(value); close(); };

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (highlighted >= 0) document.getElementById(`${listId}-${highlighted}`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted, listId]);

  return <div className="market-picker" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="market-picker-trigger" aria-label="Select market" aria-expanded={open} aria-haspopup="dialog" onClick={() => { setQuery(""); setHighlighted(-1); setOpen((value) => !value); }}><span>{symbol.replace(/USDT$/, " / USDT")}</span><span aria-hidden="true">⌕ ▾</span></button>
    {open && <div className="market-picker-menu" role="dialog" aria-label="Choose a Binance market" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <label className="sr-only" htmlFor={`${listId}-search`}>Search markets</label>
      <input ref={search} id={`${listId}-search`} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={highlighted >= 0 && highlighted < matches.length ? `${listId}-${highlighted}` : undefined} autoComplete="off" placeholder="Search symbol, e.g. XRP" value={query} onChange={(event) => { setQuery(event.target.value); setHighlighted(-1); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setHighlighted((index) => matches.length ? event.key === "ArrowDown" ? (index + 1) % matches.length : (index <= 0 ? matches.length - 1 : index - 1) : -1);
        } else if (event.key === "Enter") { event.preventDefault(); const match = matches[Math.max(0, highlighted)]; if (match) select(match.symbol); }
      }}/>
      <p className="market-picker-hint">Binance spot · USDT pairs</p>
      {loading && <p role="status">Loading markets…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !matches.length && <p role="status">No matching USDT markets.</p>}
      <div id={listId} role="listbox" aria-label="Available markets" className="market-picker-options">
        {matches.map((market, index) => <button type="button" role="option" id={`${listId}-${index}`} key={market.symbol} tabIndex={-1} aria-selected={symbol === market.symbol} className={highlighted === index ? "highlighted" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => select(market.symbol)}><strong>{market.baseAsset}<span> / {market.quoteAsset}</span></strong><small>{market.symbol}</small></button>)}
      </div>
      {!loading && !error && <p className="market-picker-hint">{filtered.length} markets{filtered.length > matches.length ? ` · showing ${matches.length}, type to narrow` : ""}</p>}
    </div>}
  </div>;
}
