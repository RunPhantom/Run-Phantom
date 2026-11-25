/**
 * Where overview buckets start. A fixed offset reproduces the original
 * `tz_offset_minutes` behaviour; an IANA zone starts every bucket at a local
 * wall-clock boundary, so days and six-hour blocks stay on local midnight
 * across a daylight-saving change.
 */
export type BucketClock = { readonly offsetMinutes: number; readonly timeZone?: undefined } | { readonly timeZone: string; readonly offsetMinutes?: undefined };

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function createFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = createFormatter(timeZone);
    formatters.set(timeZone, format);
  }
  return format;
}

/**
 * The canonical spelling of an IANA zone, or null when `value` is not one. Intl accepts any letter case, so
 * callers key caches and echo responses by this name rather than the raw request text.
 */
export function canonicalTimeZone(value: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return null;
  try { return createFormatter(value).resolvedOptions().timeZone; } catch { return null; }
}

/** Milliseconds east of UTC in effect in `timeZone` at `instant`. */
export function zoneOffsetMs(timeZone: string, instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

function localWall(timeZone: string, instant: number): number {
  return instant + zoneOffsetMs(timeZone, instant);
}

/**
 * The instant a local wall-clock time (expressed as if it were UTC) occurs. A repeated time resolves to its
 * first occurrence; a time skipped by a change resolves to the first instant after the gap. Assumes no zone
 * changes offset twice within two days.
 */
function wallToInstant(timeZone: string, wall: number): number {
  const before = wall - zoneOffsetMs(timeZone, wall - DAY_MS);
  const after = wall - zoneOffsetMs(timeZone, wall + DAY_MS);
  const valid = [before, after].filter(instant => localWall(timeZone, instant) === wall);
  if (valid.length) return Math.min(...valid);
  return before;
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

/**
 * Bucket edges covering [from, to): edges[0] <= from, edges[edges.length - 1] >= to, strictly increasing.
 * `bucketMs` must divide a day. Each edge is a local boundary, or the first instant after one a clock change
 * skipped. The next edge is one bucket later in real time when that lands on a boundary, so a repeated hour
 * gets its own bucket; otherwise it is the next boundary in wall-clock time, so a day across a change lasts
 * 23 or 25 hours and a half-hour change (Australia/Lord_Howe) does not shift later hours off the hour.
 */
export function bucketEdges(from: number, to: number, bucketMs: number, clock: BucketClock): number[] {
  const edges: number[] = [];
  if (clock.timeZone === undefined) {
    const offsetMs = clock.offsetMinutes * 60_000;
    for (let start = floorTo(from + offsetMs, bucketMs) - offsetMs; ; start += bucketMs) {
      edges.push(start);
      if (start >= to) return edges;
    }
  }
  const zone = clock.timeZone;
  let wall = floorTo(localWall(zone, from), bucketMs);
  let edge = wallToInstant(zone, wall);
  while (edge > from) edge = wallToInstant(zone, wall -= bucketMs);
  edges.push(edge);
  while (edge < to) {
    const realStep = edge + bucketMs;
    if (localWall(zone, realStep) % bucketMs === 0) {
      edge = realStep;
    } else {
      let nextWall = floorTo(localWall(zone, edge), bucketMs) + bucketMs;
      let next = wallToInstant(zone, nextWall);
      while (next <= edge) next = wallToInstant(zone, nextWall += bucketMs);
      edge = next;
    }
    edges.push(edge);
  }
  return edges;
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
