// Offline-first event queue. Every event has its own id, so sending the same batch twice is harmless:
// the server ignores ids it already has.
export interface Store { get(k: string): string | null; set(k: string, v: string): void }
export interface Batch { session: string; child: string; lesson: string; events: { id: string; at: string; type: string; [k: string]: unknown }[] }

const KEY = 'adw.queue';

export class Queue {
  private running: Promise<void> | null = null;
  constructor(private kv: Store, private send: (b: Batch) => Promise<void>, private max = 200) {}

  private load(): Batch[] { try { return JSON.parse(this.kv.get(KEY) || '[]'); } catch { return []; } }
  private save(b: Batch[]) { this.kv.set(KEY, JSON.stringify(b.filter(x => x.events.length))); }

  push(meta: Omit<Batch, 'events'>, event: Batch['events'][number]) {
    const all = this.load();
    let b = all.find(x => x.session === meta.session);
    if (!b) all.push(b = { ...meta, events: [] });
    b.events.push(event);
    this.save(all);
  }
  pending() { return this.load().reduce((n, b) => n + b.events.length, 0); }

  /** Send everything queued, one session at a time. Only events that were sent are removed. */
  flush(): Promise<void> {
    if (this.running) return this.running;
    const run = (async () => {
      await null; // let `this.running` be assigned before the body can finish (an empty queue finishes at once)
      try {
        for (const b of this.load()) {
          for (let i = 0; i < b.events.length; i += this.max) {
            const chunk = b.events.slice(i, i + this.max);
            await this.send({ ...b, events: chunk });
            const sent = new Set(chunk.map(e => e.id));
            const all = this.load();
            const cur = all.find(x => x.session === b.session);
            if (cur) cur.events = cur.events.filter(e => !sent.has(e.id));
            this.save(all);
          }
        }
      } finally { this.running = null; }
    })();
    return (this.running = run);
  }
}
