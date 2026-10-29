// Twitch lets one IRC login send 20 JOINs per 10 seconds; past that the JOINs are dropped and
// time out. Joins go out one at a time at a safe pace, never block the reconcile that asked for
// them, and a failed one is simply asked for again by the next reconcile.

/** 600 ms between JOINs: about 17 per 10 seconds, under Twitch's 20. */
export const JOIN_INTERVAL_MS = 600;

export interface JoinQueueOptions {
  join: (login: string) => Promise<unknown>;
  joined: (login: string) => boolean;
  log: (message: string, error: unknown) => void;
  intervalMs?: number;
}

export class JoinQueue {
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private pausedUntil = 0;
  private stopped = false;

  constructor(private readonly options: JoinQueueOptions) {}

  /** Asks for the channel; a no-op when it is joined or already waiting. */
  want(login: string): void {
    if (this.stopped || this.options.joined(login)) return;
    this.pending.add(login);
    this.schedule(0);
  }

  /** The channel is no longer wanted (it was parted or disabled). */
  forget(login: string): void {
    this.pending.delete(login);
  }

  /** Leaves the next `ms` of the JOIN budget to someone else, e.g. tmi's rejoin after reconnect. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  get size(): number {
    return this.pending.size;
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    if (this.timer || this.stopped || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.next();
    }, delay);
  }

  private next(): void {
    const wait = this.pausedUntil - Date.now();
    if (wait > 0) return this.schedule(wait);
    const [login] = this.pending;
    if (login === undefined) return;
    this.pending.delete(login);
    // Joined meanwhile (tmi's own rejoin): no JOIN spent, the next one goes right away.
    if (this.options.joined(login)) return this.schedule(0);
    this.options
      .join(login)
      .catch((error: unknown) => this.options.log(`IRC join ${login} failed:`, error));
    this.schedule(this.options.intervalMs ?? JOIN_INTERVAL_MS);
  }
}
