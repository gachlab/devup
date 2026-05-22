export class Broadcaster<T> {
  private readonly subs = new Set<(v: T) => void>();

  subscribe(fn: (v: T) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(v: T): void {
    for (const fn of this.subs) {
      try { fn(v); } catch { /* subscriber errors must not kill the bus */ }
    }
  }
}
