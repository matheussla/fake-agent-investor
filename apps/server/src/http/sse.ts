import { EventEmitter } from "node:events";
import type { MarketUpdate } from "@paper-investor/contracts";

export interface AppEvent { id: string; type: string; occurredAt: string; simulationId?: string; data: unknown; }

export class EventHub {
  private readonly emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(100); }
  publish(event: AppEvent) { this.emitter.emit("event", event); }
  publishMarket(update: MarketUpdate) { this.publish({ id: crypto.randomUUID(), type: update.type, occurredAt: new Date().toISOString(), data: update }); }
  subscribe(listener: (event: AppEvent) => void): () => void { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
}
