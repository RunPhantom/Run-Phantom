import { describe, expect, test } from "bun:test";
import { bucketEdges, canonicalTimeZone } from "../src/stats/time-buckets";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function localTimes(timeZone: string, edges: readonly number[]): string[] {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return edges.map(edge => format.format(edge));
}

describe("bucketEdges in a time zone", () => {
  test("a day whose local midnight is skipped starts at the first time after the gap", () => {
    expect(localTimes("America/Santiago", bucketEdges(Date.parse("2026-09-04T12:00Z"), Date.parse("2026-09-07T12:00Z"), DAY, { timeZone: "America/Santiago" })))
      .toEqual(["04/09, 00:00", "05/09, 00:00", "06/09, 01:00", "07/09, 00:00", "08/09, 00:00"]);
    expect(localTimes("America/Havana", bucketEdges(Date.parse("2026-03-06T12:00Z"), Date.parse("2026-03-09T12:00Z"), DAY, { timeZone: "America/Havana" })))
      .toEqual(["06/03, 00:00", "07/03, 00:00", "08/03, 01:00", "09/03, 00:00", "10/03, 00:00"]);
  });

  test("six-hour blocks resume on local boundaries after a skipped midnight", () => {
    expect(localTimes("America/Santiago", bucketEdges(Date.parse("2026-09-05T12:00Z"), Date.parse("2026-09-06T16:00Z"), 6 * HOUR, { timeZone: "America/Santiago" })))
      .toEqual(["05/09, 06:00", "05/09, 12:00", "05/09, 18:00", "06/09, 01:00", "06/09, 06:00", "06/09, 12:00", "06/09, 18:00"]);
  });

  test("hourly buckets stay on the hour across a half-hour change", () => {
    const spring = localTimes("Australia/Lord_Howe", bucketEdges(Date.parse("2026-10-03T13:00Z"), Date.parse("2026-10-03T19:00Z"), HOUR, { timeZone: "Australia/Lord_Howe" }));
    expect(spring).toEqual(["03/10, 23:00", "04/10, 00:00", "04/10, 01:00", "04/10, 02:30", "04/10, 03:00", "04/10, 04:00", "04/10, 05:00", "04/10, 06:00"]);
    const autumn = localTimes("Australia/Lord_Howe", bucketEdges(Date.parse("2026-04-04T13:00Z"), Date.parse("2026-04-04T18:00Z"), HOUR, { timeZone: "Australia/Lord_Howe" }));
    expect(autumn.every(time => time.endsWith(":00"))).toBe(true);
  });

  test("a repeated hour gets its own bucket", () => {
    const edges = bucketEdges(Date.parse("2026-11-01T04:00Z"), Date.parse("2026-11-01T08:00Z"), HOUR, { timeZone: "America/New_York" });
    expect(localTimes("America/New_York", edges)).toEqual(["01/11, 00:00", "01/11, 01:00", "01/11, 01:00", "01/11, 02:00", "01/11, 03:00"]);
    expect(edges.slice(1).map((edge, index) => edge - edges[index])).toEqual([HOUR, HOUR, HOUR, HOUR]);
  });

  test("every edge is strictly increasing and the edges cover the range", () => {
    for (const timeZone of ["America/Santiago", "America/Havana", "Australia/Lord_Howe", "Asia/Kathmandu", "Europe/London"]) {
      for (const bucketMs of [5 * 60_000, HOUR, 6 * HOUR, DAY]) {
        const from = Date.parse("2026-01-01T00:00Z"), to = from + (bucketMs < HOUR ? 3 * DAY : 365 * DAY);
        const edges = bucketEdges(from, to, bucketMs, { timeZone });
        expect(edges[0]).toBeLessThanOrEqual(from);
        expect(edges.at(-1)!).toBeGreaterThanOrEqual(to);
        for (let index = 1; index < edges.length; index++) expect(edges[index]).toBeGreaterThan(edges[index - 1]);
      }
    }
  });
});

describe("canonicalTimeZone", () => {
  test("canonicalises letter case and rejects unknown zones", () => {
    expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
    expect(canonicalTimeZone("AMERICA/NEW_YORK")).toBe("America/New_York");
    expect(canonicalTimeZone("Mars/Olympus_Mons")).toBeNull();
    expect(canonicalTimeZone("../etc")).toBeNull();
  });
});
