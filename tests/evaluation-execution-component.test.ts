import { expect, test } from "bun:test";
import { createRequire } from "node:module";
const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
const { renderToStaticMarkup } = appRequire("react-dom/server");
const { createElement } = appRequire("react");
import { DatasetExecution, type DatasetExecutionClient } from "../app/src/components/evaluations/DatasetExecution";
import type { DatasetRevision } from "../src/evaluations/protocol";

test("dataset inspection renders the explicit opt-in with zero transport processing", () => {
  let requests = 0;
  const forbidden = async () => { requests++; throw new Error("Inspection must not request execution capability or work"); };
  const client: DatasetExecutionClient = { capabilities: forbidden, start: forbidden, get: forbidden, cancel: forbidden };
  const revision: DatasetRevision = { datasetId: "literal", datasetName: "<img src=x onerror=alert(1)>", version: 1, hash: "a".repeat(64), cases: [], createdAt: 1 };
  const html = renderToStaticMarkup(createElement(DatasetExecution, { revision, client }));
  expect(requests).toBe(0);
  expect(html).toContain("Enable explicit execution for this dataset");
  expect(html).toContain("Grading existing captured runs remains a separate action");
  expect(html).not.toContain("Run frozen revision");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});
