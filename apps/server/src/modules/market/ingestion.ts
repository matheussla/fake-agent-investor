import type { Instrument, MarketDataProvider, MarketUpdate, ProviderHealth, Quote, CandleRequest, Candle } from "@paper-investor/contracts";

type ExchangeInfo = { symbols: Array<{ symbol: string; status: string; baseAsset: string; quoteAsset: string; isSpotTradingAllowed?: boolean; filters: Array<Record<string, string>> }> };
type SocketLike = { addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void; close(code?: number, reason?: string): void };
type Fetcher = typeof fetch;

export class BinanceMarketDataProvider implements MarketDataProvider {
  private readonly quotes = new Map<string, Quote>();
  private readonly updateIds = new Map<string, number>();
  private readonly lastClosedCandle = new Map<string, string>();
  private socket?: SocketLike;
  private healthState: ProviderHealth = { status: "unavailable", detail: "Not connected" };
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private generation = 0;
  private instrumentCatalog?: { data: Instrument[]; expiresAt: number };
  private instrumentRequest?: Promise<Instrument[]>;

  constructor(private readonly fetcher: Fetcher = fetch, private readonly createSocket: (url: string) => SocketLike = (url) => new WebSocket(url)) {}

  async instruments(signal: AbortSignal): Promise<Instrument[]> {
    signal.throwIfAborted();
    if (this.instrumentCatalog && this.instrumentCatalog.expiresAt > Date.now()) return this.instrumentCatalog.data;
    this.instrumentRequest ??= this.loadInstruments();
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try { return await Promise.race([this.instrumentRequest, cancelled]); }
    finally { signal.removeEventListener("abort", cancel); }
  }

  private async loadInstruments(): Promise<Instrument[]> {
    try {
      const response = await this.fetcher("https://api.binance.com/api/v3/exchangeInfo", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Binance exchangeInfo failed: ${response.status}`);
      const data = await response.json() as ExchangeInfo;
      const instruments: Instrument[] = data.symbols.filter((item) => item.quoteAsset === "USDT" && item.isSpotTradingAllowed !== false).map((item) => {
        const lot = item.filters.find((filter) => filter.filterType === "LOT_SIZE");
        const price = item.filters.find((filter) => filter.filterType === "PRICE_FILTER");
        const notional = item.filters.find((filter) => filter.filterType === "NOTIONAL" || filter.filterType === "MIN_NOTIONAL");
        return { symbol: item.symbol, baseAsset: item.baseAsset, quoteAsset: item.quoteAsset, status: item.status === "TRADING" ? "trading" : "unavailable", priceIncrement: price?.tickSize ?? "0", quantityIncrement: lot?.stepSize ?? "0", minimumQuantity: lot?.minQty ?? "0", minimumNotional: notional?.minNotional ?? "0" };
      });
      this.instrumentCatalog = { data: instruments, expiresAt: Date.now() + 300_000 };
      return instruments;
    } finally { this.instrumentRequest = undefined; }
  }

  cachedQuote(symbol: string): Quote | undefined {
    const quote = this.quotes.get(symbol);
    if (!quote) return;
    const now = Date.now();
    return [quote.observedAt, quote.receivedAt].every((value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= 5000;
    }) ? quote : undefined;
  }

  async quote(symbol: string, signal: AbortSignal): Promise<Quote> {
    const cached = this.cachedQuote(symbol);
    if (cached) return cached;
    const response = await this.fetcher(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, { signal });
    if (!response.ok) throw new Error(`Binance quote failed for ${symbol}: ${response.status}`);
    const data = await response.json() as { bidPrice: string; askPrice: string; bidQty: string; askQty: string };
    const now = new Date().toISOString();
    const value = { symbol, bid: data.bidPrice, ask: data.askPrice, bidSize: data.bidQty, askSize: data.askQty, observedAt: now, receivedAt: now };
    this.quotes.set(symbol, value);
    return value;
  }

  async candles(request: CandleRequest, signal: AbortSignal): Promise<Candle[]> {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.search = new URLSearchParams({ symbol: request.symbol, interval: request.interval, startTime: String(Date.parse(request.startTime)), endTime: String(Date.parse(request.endTime)), limit: "1000" }).toString();
    const response = await this.fetcher(url, { signal });
    if (!response.ok) throw new Error(`Binance candles failed for ${request.symbol}: ${response.status}`);
    const rows = await response.json() as Array<[number, string, string, string, string, string, number]>;
    return rows.map(([openTime, open, high, low, close, volume, closeTime]) => ({ symbol: request.symbol, openTime: new Date(openTime).toISOString(), closeTime: new Date(closeTime).toISOString(), open, high, low, close, volume, closed: closeTime < Date.now() }));
  }

  subscribe(symbols: string[], emit: (event: MarketUpdate) => void): () => void {
    this.stop();
    this.stopped = false;
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation;
    const normalized = [...new Set(symbols.map((symbol) => symbol.toLowerCase()))];
    let retry = 0;
    const connect = () => {
      if (!current()) return;
      const streams = normalized.flatMap((symbol) => [`${symbol}@bookTicker`, `${symbol}@ticker`, `${symbol}@kline_1m`]).join("/");
      const socket = this.createSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (!current() || this.socket !== socket) return;
        retry = 0; this.healthState = { status: "healthy", lastMessageAt: new Date().toISOString() }; emit({ type: "health", health: this.healthState });
        for (const symbol of normalized.map((value) => value.toUpperCase())) {
          const endTime = new Date();
          const startTime = this.lastClosedCandle.get(symbol) ?? new Date(endTime.getTime() - 120_000).toISOString();
          void this.candles({ symbol, interval: "1m", startTime, endTime: endTime.toISOString() }, AbortSignal.timeout(10_000))
            .then((history) => history.filter((candle) => candle.closed).forEach((candle) => {
              if (!current() || this.socket !== socket) return;
              this.lastClosedCandle.set(symbol, candle.closeTime);
              emit({ type: "candle", candle });
            }))
            .catch(() => { if (current() && this.socket === socket) emit({ type: "health", health: { status: "degraded", detail: `Candle backfill failed for ${symbol}` } }); });
        }
      });
      socket.addEventListener("message", (event) => {
        if (!current() || this.socket !== socket) return;
        try {
          const envelope = JSON.parse(String((event as MessageEvent).data)) as { stream: string; data: Record<string, unknown> };
          const data = envelope.data;
          const now = new Date().toISOString();
          if (envelope.stream.endsWith("@bookTicker")) {
            const symbol = String(data.s); const updateId = Number(data.u);
            if (Number.isFinite(updateId) && updateId <= (this.updateIds.get(symbol) ?? -1)) return;
            if (Number.isFinite(updateId)) this.updateIds.set(symbol, updateId);
            const quote = { symbol, bid: String(data.b), ask: String(data.a), bidSize: String(data.B), askSize: String(data.A), observedAt: data.E ? new Date(Number(data.E)).toISOString() : now, receivedAt: now };
            this.quotes.set(symbol, quote); emit({ type: "quote", quote });
          } else if (envelope.stream.endsWith("@ticker")) {
            emit({ type: "ticker", symbol: String(data.s), priceChangePercent: String(data.P), quoteVolume: String(data.q), observedAt: now });
          } else if (envelope.stream.endsWith("@kline_1m")) {
            const k = data.k as Record<string, unknown>;
            const candle = { symbol: String(data.s), openTime: new Date(Number(k.t)).toISOString(), closeTime: new Date(Number(k.T)).toISOString(), open: String(k.o), high: String(k.h), low: String(k.l), close: String(k.c), volume: String(k.v), closed: Boolean(k.x) };
            if (candle.closed) this.lastClosedCandle.set(candle.symbol, candle.closeTime);
            emit({ type: "candle", candle });
          }
          this.healthState = { status: "healthy", lastMessageAt: now };
        } catch { this.healthState = { status: "degraded", detail: "Malformed Binance stream event" }; emit({ type: "health", health: this.healthState }); }
      });
      socket.addEventListener("error", () => {
        if (!current() || this.socket !== socket) return;
        this.healthState = { status: "degraded", detail: "Binance WebSocket error" }; emit({ type: "health", health: this.healthState });
      });
      socket.addEventListener("close", () => {
        if (!current() || this.socket !== socket) return;
        this.healthState = { status: "degraded", detail: "Reconnecting to Binance" }; emit({ type: "health", health: this.healthState });
        retry += 1;
        this.reconnectTimer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(retry, 6)));
      });
    };
    connect();
    return () => { if (generation === this.generation) this.stop(); };
  }

  health(symbol?: string): ProviderHealth {
    if (!symbol) return this.healthState;
    const quote = this.quotes.get(symbol);
    if (!quote || Date.now() - Date.parse(quote.receivedAt) > 60_000) return { status: "degraded", symbol, detail: `No fresh ${symbol} quote` };
    return { ...this.healthState, symbol };
  }

  private stop() {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, "Subscription stopped");
    this.socket = undefined;
  }
}
