# Captured agent definition versions

Run Phantom can compare the configuration captured with an agent span independently of its request, output and action correspondence. In an existing run comparison, expand **Captured definitions** to inspect each source span, its exact prompt hash, component hashes, and a complete semantic version when the evidence supports one. Source links open the original span and preserve its captured input and output.

Hashes describe observed configuration. Equal hashes do not establish invocation identity, equivalent runs, independent trials or a successful fix. Definition metadata does not change evaluation rules, comparison counts or machine verdicts.

## Explicit captured definition

Emit a string-valued span attribute named `runphantom.agent.definition` containing this closed JSON shape:

```json
{
  "version": 1,
  "systemPrompt": "Original instructions, including their exact whitespace",
  "tools": [
    {
      "name": "lookup",
      "description": "Find a captured record",
      "parameters": { "type": "object", "properties": { "query": { "type": "string" } } }
    }
  ],
  "model": "captured-model",
  "providers": ["captured-provider"],
  "runtime": { "temperature": 0.123456789, "maxOutputTokens": 1024 }
}
```

All fields are required for a complete version. An empty tool list is valid. Tools need a unique literal name, an observed description, and exactly one full `parameters`, `input_schema` or `schema` value. A wrapped `{ "type": "function", "function": { ... } }` tool is also supported. Tool descriptions, schema contents and additional captured tool fields remain material. Top-level extension fields and unknown capture versions are refused.

The prompt component uses full SHA-256 over the original observed UTF-8 text. The semantic digest uses `runphantom-agent-definition/v1`, full SHA-256, deterministic Unicode codepoint key/tool ordering, literal strings and exact finite numeric evidence. Provider membership is an order-insensitive set of literal names; nested array order remains material. No prompt trimming, whitespace normalization, provider aliases, shortened hashes or runtime rounding is applied. Unrepresentable numeric evidence, unsafe integers and negative zero are unavailable.

## Complete, partial and unavailable evidence

A complete version requires one unambiguous explicit span capture and its original bounded typed OTLP receipt. Flattened attributes alone cannot prove authority. Duplicate explicit keys, inherited resource/scope collisions, receiver or SDK-reported loss, redaction, invalid identities and missing/oversized receipts retain partial or unavailable versions. Invalid explicit capture never falls back to legacy inference.

Legacy `gen_ai.system_instructions` and `gen_ai.tool.definitions` may retain safe observed component evidence alongside model/provider attributes. They remain partial and never infer a complete configuration from a user query, tool action list or matching prompt.

The reader uses the same admitted span population as the existing comparison or evaluation snapshot. Comparison acquisition remains 2,000 spans / 8 MiB; evaluation acquisition remains 5,000 spans / 32 MiB. Definition fields and acquired original receipts are withheld above 64 KiB before materialization. A definition allows at most 64 tools, 32 provider names, 5,000 JSON nodes and depth 16. Existing OTLP capture also retains its 4,096-character typed string limit; a larger original JSON attribute can therefore be partial even when its flattened copy is present.

At most 32 definition records are retained per run, with a 16 KiB safe metadata ceiling. Observed and omitted record counts and unavailable attribute counts are explicit. Frozen snapshots retain their existing 64 KiB total ceiling: definition metadata uses only the space remaining after established input/output/tool evidence. Absent metadata can mean a legacy snapshot, no observed capture or unavailable retained capacity; absence establishes no complete version.

## Privacy, live updates and frozen reports

Known-secret and existing redaction checks run before any prompt or semantic fingerprint. Secret-bearing definitions cannot expose credential hashes through a safe-looking prompt component. Runtime keys remain exactly captured: for example, the existing `max_tokens` redaction policy produces unavailable evidence; it is never rewritten to `maxOutputTokens` or exempted from the redaction floor.

Default run detail, span metadata, attribute search and portable trace export replace the new definition value with `[REDACTED]`. Ordered typed receipt occurrences in span/resource/scope/event/link or nested attribute values use the existing `{ "stringValue": "[REDACTED]" }` marker and count newly withheld values once. Existing source counts, order, timing, unrelated attributes and captured input/output stay intact. Reimporting this public form retains explicit partial/redacted provenance; it cannot reconstruct a complete version from withheld content.

Nested typed composites project the same exact definition key out of their flattened companion only when validated ordered source evidence proves an unambiguous, loss-free correspondence. Other sibling values and material array order remain exact. Genuine typed `stringValue` business text stays a string even when it looks like JSON. Missing, oversized, ambiguous or lossy relevant source makes the flattened carrier `[UNAVAILABLE]`; malformed relevant receipts cannot authorize public typed projection. Ordinary attribute search treats an invalid companion as unavailable before matching and never searches its raw private counterpart.

Span search acquires only its already-selected scopes plus a complete typed companion where attributes are requested, in one read-only transaction. SQL checks the selected row count and every acquired text column before loading rows: at most 2,000 rows and 16 MiB aggregate UTF-8. Typed companions above the existing 256 KiB receipt ceiling are withheld whole in SQL. Searches above the aggregate or row budget return HTTP 413 rather than sampled or falsely empty results. Existing pattern, response, match and live-event limits remain in force.

Import identity checks compare original admitted private columns internally, using the same bounded transactional population. Reimporting an identical private capture preserves its existing span row identity and references. This internal equality check provides no public raw-export option: portable exports always withhold the definition, including when transferred into a fresh profile.

The local read-only SQL diagnostic endpoint remains privileged access to the user's private capture store under its existing host/origin guards. It can read original definition columns and is outside the default public projection boundary. This feature does not add that raw diagnostic seam to the shared service or claim global private-data containment for arbitrary local SQL.

An authoritative duplicate-root update can change the current definition hash without adding a second span. Completed experiment snapshots and JSON/JUnit reports retain their original safe definition identities after later capture corrections, process restart or source changes. Report export validates the closed safe provenance and never rederives it from mutable raw spans. Older snapshots without definition metadata remain compatible.

The comparison subsection uses the application’s cobalt/ink/canvas design, self-hosted Syne with its complete OFL notice, and the existing Inter font. Its details, source links and local scrolling work with keyboard and touch. Global shell composition and platform-wide/provider acceptance are separate qualification scopes.
