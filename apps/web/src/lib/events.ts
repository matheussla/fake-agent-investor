export interface LiveEventSource {
  onopen: ((event: Event) => void) | null;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

const watchedEvents = ["snapshot-required", "quote", "candle", "health", "decision", "execution", "portfolio", "status", "team-run", "agents"];

export function connectLiveEvents(onRefresh: () => void, source: LiveEventSource = new EventSource("/api/events"), events: readonly string[] = watchedEvents): () => void {
  source.onopen = onRefresh;
  for (const event of events) source.addEventListener(event, onRefresh as EventListener);
  return () => source.close();
}
