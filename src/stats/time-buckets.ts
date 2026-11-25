/**
 * Where overview buckets start. A fixed offset reproduces the original
 * `tz_offset_minutes` behaviour; an IANA zone starts every bucket at a local
 * wall-clock boundary, so days and six-hour blocks stay on local midnight
 * across a daylight-saving change.
 */
export type BucketClock = { readonly offsetMinutes: number; readonly timeZone?: undefined } | { readonly timeZone: string; readonly offsetMinutes?: undefined };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, format);
  }
  return format;
}

export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return false;
  try { formatter(value); return true; } catch { return false; }
}

/** Milliseconds east of UTC in effect in `timeZone` at `instant`. */
export function zoneOffsetMs(timeZone: string, instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant a local wall-clock time (expressed as if it were UTC) occurs; a time skipped by a change lands just after it. */
function wallToInstant(timeZone: string, wall: number): number {
  const guess = wall - zoneOffsetMs(timeZone, wall);
  return wall - zoneOffsetMs(timeZone, guess);
}

/**
 * Bucket edges covering [from, to): edges[0] <= from, edges[edges.length - 1] >= to, strictly increasing.
 * `bucketMs` must divide a day. Buckets of an hour or less step in real time from a local boundary (every
 * real offset change is a multiple of 30 minutes, so they stay on local boundaries); longer buckets step in
 * local wall-clock time, so a day across a change lasts 23 or 25 hours.
 */
export function bucketEdges(from: number, to: number, bucketMs: number, clock: BucketClock): number[] {
  const edges: number[] = [];
  if (clock.timeZone === undefined) {
    const offsetMs = clock.offsetMinutes * 60_000;
    for (let start = Math.floor((from + offsetMs) / bucketMs) * bucketMs - offsetMs; ; start += bucketMs) {
      edges.push(start);
      if (start >= to) return edges;
    }
  }
  const zone = clock.timeZone;
  let wall = Math.floor((from + zoneOffsetMs(zone, from)) / bucketMs) * bucketMs;
  while (wallToInstant(zone, wall) > from) wall -= bucketMs;
  if (bucketMs <= 3_600_000) {
    for (let start = wallToInstant(zone, wall); ; start += bucketMs) {
      edges.push(start);
      if (start >= to) return edges;
    }
  }
  for (; ; wall += bucketMs) {
    const edge = wallToInstant(zone, wall);
    if (edges.length && edge <= edges[edges.length - 1]) continue;
    edges.push(edge);
    if (edge >= to) return edges;
  }
}

/** Index of the bucket holding `instant`, or -1 when it falls outside the edges. */
export function bucketIndex(edges: readonly number[], instant: number): number {
  let low = 0, high = edges.length - 1;
  if (instant < edges[0] || instant >= edges[high]) return -1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (edges[mid] <= instant) low = mid; else high = mid;
  }
  return low;
}
