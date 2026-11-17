import { describe, expect, it, vi } from "vitest";
import { connectLiveEvents, type LiveEventSource } from "./events.js";

class FakeEventSource implements LiveEventSource {
  onopen: ((event: Event) => void) | null = null;
  listeners = new Map<string, EventListener[]>();
  closed = false;
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  close() { this.closed = true; }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(new Event(type)); }
  reconnect() { this.onopen?.(new Event("open")); }
}

describe("live event lifecycle", () => {
  it("refreshes after snapshots, updates, and reconnects, then closes cleanly", () => {
    const source = new FakeEventSource();
    const refresh = vi.fn();
    const disconnect = connectLiveEvents(refresh, source);
    source.emit("snapshot-required");
    source.emit("decision");
    source.reconnect();
    expect(refresh).toHaveBeenCalledTimes(3);
    disconnect();
    expect(source.closed).toBe(true);
  });
});
