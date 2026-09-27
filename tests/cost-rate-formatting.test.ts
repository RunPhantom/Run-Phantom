import { describe, expect, test } from "bun:test";
import { fmtRate } from "../app/src/utils/costs";

describe("per-million rate formatting", () => {
  // OpenRouter prices per token; scaling "0.0000004" by 1e6 yields 0.39999999999999997,
  // which the Cost Breakdown printed verbatim as "$0.39999999999999997/M".
  test("float noise from per-token scaling is removed", () => {
    expect(fmtRate(parseFloat("0.0000004") * 1_000_000)).toBe("$0.4");
    expect(fmtRate(parseFloat("0.00000015") * 1_000_000)).toBe("$0.15");
    expect(fmtRate(parseFloat("0.0000011") * 1_000_000)).toBe("$1.1");
  });

  test("clean rates keep their exact value without padding", () => {
    expect(fmtRate(3)).toBe("$3");
    expect(fmtRate(15)).toBe("$15");
    expect(fmtRate(1.25)).toBe("$1.25");
    expect(fmtRate(0.075)).toBe("$0.075");
    expect(fmtRate(0.0375)).toBe("$0.0375");
  });

  test("precision is bounded to four significant digits", () => {
    expect(fmtRate(1.23456)).toBe("$1.235");
    expect(fmtRate(0.000012345)).toBe("$0.00001235");
  });

  test("large and tiny rates never fall back to exponent notation", () => {
    expect(fmtRate(1200)).toBe("$1,200");
    expect(fmtRate(1e-7)).toBe("$0.0000001");
  });
});
