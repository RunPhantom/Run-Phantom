import { expect, test } from "bun:test";
import { describePredicate } from "../app/src/components/verification/PredicateEditor";
test("existing saved-flow description admits numeric lab labels without changing prior labels", () => {
  expect(describePredicate({ kind: "performance", metric: "clsMaxSessionScore", op: "lte", value: 0.100000001 })).toBe("Native lab clsMaxSessionScore at most 0.100000001");
  expect(describePredicate({ kind: "performance", metric: "resourceCount", op: "gte", value: 0 })).toBe("Native lab resourceCount at least 0");
  expect(describePredicate({ kind: "console", level: "error", absent: true })).toBe("No console errors");
  expect(describePredicate({ kind: "element", selector: "#safe", state: "present" })).toBe("#safe is present");
});
