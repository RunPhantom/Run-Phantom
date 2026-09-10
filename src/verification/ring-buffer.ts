/** Bounded in-memory event buffer for a verification session.
 *
 * Evidence is capped by count, bytes and age so a long-running page cannot grow
 * the daemon's memory without limit. Eviction is FIFO: every captured event
 * contributes evidence, so the oldest is dropped rather than the least active,
 * and window loss is reported so an assertion knows its evidence was partial.
 */
import { VERIFICATION_LIMITS, type RuntimeEvent } from "./protocol";
type BufferedEvent = RuntimeEvent;
const RING_BUFFER_DEFAULTS = {
  MAX_EVENTS: VERIFICATION_LIMITS.MAX_EVENTS,
  MAX_AGE_MS: VERIFICATION_LIMITS.MAX_EVENT_AGE_MS,
  MAX_BYTES: VERIFICATION_LIMITS.MAX_BUFFER_BYTES,
};

interface RingBufferOptions {
  maxEvents?: number;
  maxAgeMs?: number;
  maxBytes?: number;
}

/**
 * Bounded, time-aware event store per session. The single data structure that powers
 * observe/wait_for/assert — it lets us look both backward (recent buffer) and
 * forward (await new events).
 *
 * Eviction advances a HEAD index instead of shift/splice — O(1) per dropped event (was O(n) per
 * shift, i.e. O(n) per push at steady state under the DOM/animation floods). The dead prefix is
 * compacted away once it dominates, so the backing arrays stay bounded (amortized O(1)).
 *
 * `now` is injected so the buffer is deterministically testable (inject the clock, never call
 * Date.now inside logic).
 */
export class RingBuffer {
  readonly #maxEvents: number;
  readonly #maxAgeMs: number;
  readonly #maxBytes: number;
  #events: BufferedEvent[] = [];
  #eventBytes: number[] = [];
  /** Index of the first LIVE event; [0, #head) are evicted but not yet compacted out of the arrays. */
  #head = 0;
  #totalBytes = 0;
  #droppedCount = 0;
  /** Newest evicted timestamp distinguishes loss in this observation window from older drops. */
  #lastLossT: number | undefined;
  #lastT = -1;

  constructor(options: RingBufferOptions = {}) {
    this.#maxEvents = options.maxEvents ?? RING_BUFFER_DEFAULTS.MAX_EVENTS;
    this.#maxAgeMs = options.maxAgeMs ?? RING_BUFFER_DEFAULTS.MAX_AGE_MS;
    this.#maxBytes = options.maxBytes ?? RING_BUFFER_DEFAULTS.MAX_BYTES;
    for (const limit of [this.#maxEvents, this.#maxAgeMs, this.#maxBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("buffer limits must be positive safe integers");
    }
  }

  #liveCount(): number {
    return this.#events.length - this.#head;
  }

  push(event: BufferedEvent, now: number, byteSize?: number): void {
    // Prefer the size measured at the parse boundary (the raw wire frame the bridge already has) over
    // re-serializing here — a JSON.stringify per pushed event was the buffer's highest constant cost.
    const bytes = byteSize ?? new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (!Number.isFinite(event.t) || event.t < 0 || event.t < this.#lastT || !Number.isFinite(now) || now < event.t) {
      throw new RangeError("events require an ordered daemon timestamp no later than now");
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > VERIFICATION_LIMITS.MAX_EVENT_BYTES || bytes > this.#maxBytes) {
      throw new RangeError("event exceeds the buffer's event byte limit");
    }
    this.#lastT = event.t;
    this.#events.push(event);
    this.#eventBytes.push(bytes);
    this.#totalBytes += bytes;
    this.#evict(now);
  }

  /** Events at or after a given timestamp cursor. */
  since(cursor: number): BufferedEvent[] {
    return this.#events.slice(this.#lowerBound(cursor));
  }

  /** Events within the last `windowMs`, relative to `now`. */
  window(windowMs: number, now: number): BufferedEvent[] {
    return this.#events.slice(this.#lowerBound(now - windowMs));
  }

  /** Binary search over the LIVE window [#head, length) for the first event at/after `target`. */
  #lowerBound(target: number): number {
    let lo = this.#head;
    let hi = this.#events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.#events[mid]?.t ?? 0) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #evict(now: number): void {
    const cutoff = now - this.#maxAgeMs;
    const before = this.#liveCount();
    // Every runtime event contributes evidence. Evict oldest first under count/byte pressure;
    // push already rejects a single event larger than the entire byte budget.
    while (
      this.#liveCount() > this.#maxEvents ||
      (this.#totalBytes > this.#maxBytes && this.#liveCount() > 1)
    ) {
      this.#noteLoss(this.#head);
      this.#totalBytes -= this.#eventBytes[this.#head] ?? 0;
      this.#head += 1;
    }
    while (this.#liveCount() > 0 && (this.#events[this.#head]?.t ?? cutoff) < cutoff) {
      this.#noteLoss(this.#head);
      this.#totalBytes -= this.#eventBytes[this.#head] ?? 0;
      this.#head += 1;
    }
    this.#droppedCount += before - this.#liveCount();
    // Reclaim the dead prefix once it dominates the backing arrays (amortized O(1) compaction).
    if (this.#head > 1024 && this.#head * 2 >= this.#events.length) {
      this.#events = this.#events.slice(this.#head);
      this.#eventBytes = this.#eventBytes.slice(this.#head);
      this.#head = 0;
    }
  }

  #noteLoss(index: number): void {
    const victim = this.#events[index];
    if (victim === undefined) return;
    if (this.#lastLossT === undefined || victim.t > this.#lastLossT) {
      this.#lastLossT = victim.t;
    }
  }

  /** Whether any evicted evidence belonged to a window opened at `cursor`. */
  lostSince(cursor: number): boolean {
    return this.#lastLossT !== undefined && this.#lastLossT >= cursor;
  }

  /** Snapshot of buffer health for the agent — live events held and cumulative drops since connect. */
  bufferHealth(): { total: number; dropped: number } {
    return { total: this.#liveCount(), dropped: this.#droppedCount };
  }
}
