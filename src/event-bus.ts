import type { SDKEventMap, SDKEventName } from "./types.js";

type Handler<T> = (payload: T) => void;

export class EventBus {
  private listeners: Partial<{
    [K in SDKEventName]: Array<Handler<SDKEventMap[K]>>;
  }> = {};

  on<K extends SDKEventName>(event: K, handler: Handler<SDKEventMap[K]>): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = [] as unknown as typeof this.listeners[K];
    }
    (this.listeners[event] as Array<Handler<SDKEventMap[K]>>).push(handler);

    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  off<K extends SDKEventName>(event: K, handler: Handler<SDKEventMap[K]>): void {
    const arr = this.listeners[event] as Array<Handler<SDKEventMap[K]>> | undefined;
    if (!arr) return;
    const idx = arr.indexOf(handler);
    if (idx !== -1) arr.splice(idx, 1);
  }

  emit<K extends SDKEventName>(event: K, payload: SDKEventMap[K]): void {
    const arr = this.listeners[event] as Array<Handler<SDKEventMap[K]>> | undefined;
    if (!arr) return;
    for (const handler of [...arr]) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[personalize-sdk] Unhandled error in "${event}" listener:`, e);
      }
    }
  }

  removeAll(): void {
    this.listeners = {};
  }
}
