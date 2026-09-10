import { describe, expect, test } from "bun:test";
import { fmt, ago, plural, isoTimestamp } from "../app/src/utils/helpers";

describe("duration formatting", () => {
  test("sub-millisecond and millisecond ranges", () => {
    expect(fmt(0.4)).toBe("<1ms");
    expect(fmt(1)).toBe("1ms");
    expect(fmt(999)).toBe("999ms");
  });

  test("seconds and minutes", () => {
    expect(fmt(1500)).toBe("1.5s");
    expect(fmt(90_000)).toBe("1.5m");
  });

  // Minutes used to be the largest unit, so a long agent run read as "205.0m".
  test("hours get their own unit", () => {
    expect(fmt(3_600_000)).toBe("1h");
    expect(fmt(12_300_000)).toBe("3h 25m");
    expect(fmt(7_200_000)).toBe("2h");
  });

  test("days get their own unit", () => {
    expect(fmt(86_400_000)).toBe("1d");
    expect(fmt(97_200_000)).toBe("1d 3h");
  });

  test("rounding never produces 60 minutes or 24 hours", () => {
    expect(fmt(3_599_000)).toBe("60.0m");
    expect(fmt(3_600_000 + 3_599_000)).toBe("2h");
    expect(fmt(86_400_000 - 1_000)).toBe("1d");
  });

  test("invalid input stays a dash", () => {
    for (const v of [null, undefined, NaN, Infinity, -1]) expect(fmt(v as number)).toBe("—");
  });
});

describe("relative time", () => {
  test("a future timestamp is labelled, not shown as elapsed", () => {
    expect(ago(Date.now() + 3_600_000)).toBe("in the future");
  });

  test("small clock skew still reads as now", () => {
    expect(ago(Date.now() + 1_000)).toBe("just now");
    expect(ago(Date.now() - 1_000)).toBe("just now");
  });

  test("ordinary past values are unchanged", () => {
    expect(ago(Date.now() - 120_000)).toBe("2m ago");
    expect(ago(Date.now() - 7_200_000)).toBe("2h ago");
  });
});

describe("pluralisation", () => {
  test("one item uses the singular", () => {
    expect(plural(1, "span")).toBe("1 span");
    expect(plural(1, "run error")).toBe("1 run error");
  });

  test("zero and many use the plural", () => {
    expect(plural(0, "span")).toBe("0 spans");
    expect(plural(7, "tool")).toBe("7 tools");
  });

  test("an irregular plural can be given explicitly", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });
});

describe("absolute timestamps", () => {
  test("are marked UTC, because relative times elsewhere are local", () => {
    expect(isoTimestamp(1_700_000_000_000)).toMatch(/ UTC$/);
    expect(isoTimestamp(1_700_000_000_000)).toStartWith("2023-11-14 22:13:20");
  });

  test("invalid input stays a dash", () => {
    for (const v of [null, undefined, NaN, Infinity]) expect(isoTimestamp(v as number)).toBe("—");
  });
});
