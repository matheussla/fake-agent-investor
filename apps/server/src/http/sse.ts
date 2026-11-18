import { EventEmitter } from "node:events";
import type { MarketUpdate, ProviderHealth } from "@paper-investor/contracts";

export interface AppEvent { id: string; type: string; occurredAt: string; simulationId?: string; data: unknown; }

export class EventHub {
  private readonly emitter = new EventEmitter();
  private marketStatus = "unavailable";
  private readonly symbolStatus = new Map<string, ProviderHealth["status"]>();
  constructor() { this.emitter.setMaxListeners(100); }
  publish(event: AppEvent) { this.emitter.emit("event", event); }
  setMarketSymbols(symbols: string[]) {
    const active = new Set(symbols);
    for (const symbol of this.symbolStatus.keys()) if (!active.has(symbol)) this.symbolStatus.delete(symbol);
  }
  publishMarket(update: MarketUpdate) {
    if (update.type === "health") {
      this.marketStatus = update.health.status;
      if (update.health.symbol) this.symbolStatus.set(update.health.symbol, update.health.status);
    }
    this.publish({ id: crypto.randomUUID(), type: update.type, occurredAt: new Date().toISOString(), data: update });
  }
  health() {
    if ([...this.symbolStatus.values()].includes("unavailable")) return "unavailable";
    if ([...this.symbolStatus.values()].includes("degraded")) return "degraded";
    return this.marketStatus;
  }
  subscribe(listener: (event: AppEvent) => void): () => void { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
}
