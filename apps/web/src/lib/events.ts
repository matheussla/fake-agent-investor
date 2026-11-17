export interface LiveEventSource {
  onopen: ((event: Event) => void) | null;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

const watchedEvents = ["snapshot-required", "quote", "candle", "health", "decision", "execution", "portfolio", "status"];

export function connectLiveEvents(onRefresh: () => void, source: LiveEventSource = new EventSource("/api/events")): () => void {
  source.onopen = onRefresh;
  for (const event of watchedEvents) source.addEventListener(event, onRefresh as EventListener);
  return () => source.close();
}
