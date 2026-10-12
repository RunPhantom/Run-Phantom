import { expect, test } from "bun:test";
import { observeOtlpTagSource, ambiguousOtlpTagSpans, OTLP_TAG_SOURCE_LIMITS as L } from "../src/otlp-tag-source";
import { parseOtlpRequest } from "../src/parse";
import { normalizeTeamIngest } from "../src/team/ingest";

const tag = '{"key":"tags","value":{"arrayValue":{"values":[{"stringValue":"safe"}]}}}';
const metadata = '"traceId":"' + "1".repeat(32) + '","spanId":"' + "2".repeat(16) + '","name":"Exact source","startTimeUnixNano":"1800000000000000000","endTimeUnixNano":"1800000000000000000"';
const span = (attributes: string) => `{${metadata},"attributes":[${attributes}]}`;
const batch = (spans: string, extra = "") => `{"resourceSpans":[{"scopeSpans":[{"spans":[${spans}]}]}]${extra}}`;

test("targeted original JSON observes escaped and reordered carrier duplicates without mutating source", () => {
  const duplicateCarriers = [
    '{"key":"tags","value":{"arrayValue":{"values":[],"values":[{"stringValue":"safe"}]}}}',
    '{"value":{"arrayValue":{"values":[],"v\\u0061lues":[{"stringValue":"safe"}]}},"key":"t\\u0061gs"}',
    '{"key":"tags","value":{"arrayValue":{},"arrayValue":{"values":[{"stringValue":"safe"}]}}}',
    '{"key":"tags","value":{"arrayValue":{"values":[{"stringValue":"first","stringValue":"safe"}]}}}',
    '{"key":"tags","value":{"stringValue":"first"},"value":{"arrayValue":{"values":[{"stringValue":"safe"}]}}}',
    '{"key":"other","key":"tags","value":{"arrayValue":{"values":[{"stringValue":"safe"}]}}}',
    '{"key":"tags","ke\\u0079":"tags","value":{"arrayValue":{"values":[{"stringValue":"safe"}]}}}',
  ];
  for (const carrier of duplicateCarriers) {
    const raw = batch(span(carrier) + "," + span(tag)), body = JSON.parse(raw), original = JSON.stringify(body);
    const observation = observeOtlpTagSource(raw), affected = ambiguousOtlpTagSpans(body, observation);
    expect(observation.complete).toBe(true); expect([...observation.unavailablePaths]).toEqual(["0/0/0"]);
    const result = parseOtlpRequest(body, affected);
    expect(result[0].attributes.tags).toBe("[UNAVAILABLE]"); expect(result[1].attributes.tags).toEqual(["safe"]);
    expect(JSON.stringify(body)).toBe(original);
    expect(JSON.parse(normalizeTeamIngest(Buffer.from(batch(span(carrier))), "json", "").captures[0].span.attributes!).tags).toBe("[UNAVAILABLE]");
  }
});

test("structural duplicate aliases cover only surviving descendant span tag populations", () => {
  const affectedSpan = `{${metadata},"attributes":[],"attributes":[${tag}]}`;
  for (const [raw, paths] of [
    [batch(affectedSpan + "," + span(tag)), ["0/0/0"]],
    [batch(`{${metadata},"attributes":[${tag}],"droppedAttributesCount":1,"droppedAttributesCount":0},` + span(tag)), ["0/0/0"]],
    [`{"resourceSpans":[{"scopeSpans":[],"scopeSpans":[{"spans":[${span(tag)}]}]},{"scopeSpans":[{"spans":[${span(tag)}]}]}]}`, ["0"]],
    [`{"resourceSpans":[{"scopeSpans":[{"spans":[],"spans":[${span(tag)}]},{"spans":[${span(tag)}]}]}]}`, ["0/0"]],
    [`{"resourceSpans":[],"resource\\u0053pans":[{"scopeSpans":[{"spans":[${span(tag)}]}]}]}`, [""]],
  ] as const) {
    const observation = observeOtlpTagSource(raw); expect(observation.complete).toBe(true); expect([...observation.unavailablePaths]).toEqual([...paths]);
    const result = parseOtlpRequest(JSON.parse(raw), ambiguousOtlpTagSpans(JSON.parse(raw), observation));
    // WeakSet identity belongs to the exact parsed source object, never ids.
    expect(result[0].attributes.tags).toEqual(["safe"]);
    const body = JSON.parse(raw), actual = parseOtlpRequest(body, ambiguousOtlpTagSpans(body, observation));
    expect(actual[0].attributes.tags).toBe("[UNAVAILABLE]");
    if (actual.length > 1) expect(actual[1].attributes.tags).toEqual(["safe"]);
  }
});

test("unrelated duplicates and deeply escaped business strings retain exact parser behavior", () => {
  const business = '"\\'.repeat(10_000) + '{"values":[],"values":["tags"]}';
  const raw = batch(span(tag + ',{"key":"business","value":{"stringValue":"first","stringValue":"last"}},{"key":"input.value","value":{"stringValue":' + JSON.stringify(business) + '}}'));
  const body = JSON.parse(raw), before = JSON.stringify(body), observation = observeOtlpTagSource(raw);
  expect(observation.complete).toBe(true); expect(observation.unavailablePaths.size).toBe(0);
  const result = parseOtlpRequest(body, ambiguousOtlpTagSpans(body, observation));
  expect(result[0].attributes.tags).toEqual(["safe"]); expect(result[0].attributes.business).toBe("last"); expect(result[0].inputPayload).toBe(business);
  expect(JSON.stringify(body)).toBe(before);
});

test("source budgets close only derived tag availability with bounded schema indices", () => {
  const ordinary = JSON.parse(batch(span(tag)));
  const close = (raw: string) => {
    const observation = observeOtlpTagSource(raw); expect(observation.complete).toBe(false);
    expect(observation.unavailablePaths.size).toBe(0); expect(ambiguousOtlpTagSpans(ordinary, observation).has(ordinary.resourceSpans[0].scopeSpans[0].spans[0])).toBe(true);
  };
  expect(observeOtlpTagSource("[".repeat(L.depth) + "0" + "]".repeat(L.depth)).complete).toBe(true);
  close("[".repeat(L.depth + 1) + "0" + "]".repeat(L.depth + 1));
  const duplicate = '{"attributes":[],"attributes":[]}';
  const exactPaths = observeOtlpTagSource(batch(Array(L.paths).fill(duplicate).join(",")));
  expect(exactPaths.complete).toBe(true); expect(exactPaths.unavailablePaths.size).toBe(L.paths);
  close(batch(Array(L.paths + 1).fill(duplicate).join(",")));
  close(batch(span(tag), ',"padding":[' + Array(L.tokens).fill("0").join(",") + "]"));
  const numeric = batch(span(tag), ',"schemaIndex":9007199254740993,"padding":{"9007199254740993":"not an array index"}');
  expect(observeOtlpTagSource(numeric).complete).toBe(true); expect(observeOtlpTagSource(numeric).unavailablePaths.size).toBe(0);
  const objectIndices = { resourceSpans: { "9007199254740993": ordinary.resourceSpans[0] } };
  expect(ambiguousOtlpTagSpans(objectIndices, { complete: false, unavailablePaths: new Set() }).has(ordinary.resourceSpans[0].scopeSpans[0].spans[0])).toBe(false);
});

test("the original expanded-byte ceiling is exact without a second value tree", () => {
  const prefix = '{"business":"', suffix = '"}';
  const exact = prefix + "x".repeat(L.bytes - prefix.length - suffix.length) + suffix;
  expect(observeOtlpTagSource(exact).complete).toBe(true);
  expect(observeOtlpTagSource(exact + " ").complete).toBe(false);
});
