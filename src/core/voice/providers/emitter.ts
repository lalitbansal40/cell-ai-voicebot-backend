/** Minimal typed event emitter (one listener list per event, sync delivery). */
export class TypedEmitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  private readonly listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const fn of this.listeners.get(event) ?? []) {
      (fn as (...a: Parameters<Events[K]>) => void)(...args);
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
