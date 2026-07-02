export type EventListener<T = any> = (event: T) => void | Promise<void>;

export interface RuntimeEvent {
  type: string;
  timestamp: number;
  payload: any;
  source: string;
}

export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly history: RuntimeEvent[] = [];
  private readonly maxHistory = 1000;

  /**
   * Register a subscriber for a specific event type, or '*' for all events.
   */
  subscribe(type: string, listener: EventListener): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    const set = this.listeners.get(type)!;
    set.add(listener);

    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  /**
   * Event listener alias for subscribe to match standard event listener API requirements.
   */
  on(type: string, listener: EventListener): () => void {
    return this.subscribe(type, listener);
  }

  /**
   * Publish an event to all matching subscribers.
   */
  publish(type: string, payload: any, source = 'system'): void {
    const event: RuntimeEvent = {
      type,
      timestamp: Date.now(),
      payload,
      source,
    };

    // Store in history
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Call exact subscribers
    const exactSubscribers = this.listeners.get(type);
    if (exactSubscribers) {
      for (const listener of exactSubscribers) {
        void Promise.resolve(listener(payload)).catch((err) => {
          console.error(`[EventBus] Subscriber failed for event "${type}":`, err);
        });
      }
    }

    // Call wildcard subscribers
    const wildcardSubscribers = this.listeners.get('*');
    if (wildcardSubscribers) {
      for (const listener of wildcardSubscribers) {
        void Promise.resolve(listener(event)).catch((err) => {
          console.error(`[EventBus] Wildcard subscriber failed for event "${type}":`, err);
        });
      }
    }
  }

  /**
   * Emit alias for publish to maintain compatibility with existing execution-engine imports.
   * Returns a Promise so callers can await event dispatch completion.
   */
  async emit(type: string, payload: any, source = 'system'): Promise<void> {
    this.publish(type, payload, source);
  }

  /**
   * Return a snapshot list of recent published events.
   */
  getHistory(): RuntimeEvent[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history.length = 0;
  }
}

export { EventBus as RuntimeEventBus };
export const globalEventBus = new EventBus();
