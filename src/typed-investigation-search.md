# Typed investigation search

Open **Search** for a local profile, or **Traces** in a private Team project. Keep the existing text, status, model and provider controls, then open **Advanced filters** to add captured conditions. Choose **Matching spans** to inspect safe input/output excerpts and open the original captured step. Enter in the value input adds a condition; the chips remove conditions, and Undo/Redo restores recent in-memory edits.

Every model, provider, duration, captured cost and tag condition must match the same captured span. A run containing a model on one step and a provider on another does not satisfy both. Run status applies to the containing run. Text searches treat quotes, SQL-looking text, `%`, `_` and Unicode as literals; ASCII letters fold case, while Unicode keeps SQLite's literal comparison behavior.

| Field | Values | Operators |
| --- | --- | --- |
| `status` | `running`, `completed`, `failed` | `eq`, `ne` |
| `model`, `provider`, `tag` | Exact captured string | `eq`, `ne` |
| `duration_ms`, `captured_cost_usd` | Finite nonnegative number | `eq`, `ne`, `lt`, `lte`, `gt`, `gte` |

Captured cost uses reported exporter cost, with the first present supported alias retaining authority. Missing, malformed, duplicated, or unavailable evidence proves neither zero nor absence. Explicit zero remains valid. Tags require a complete captured array: at most 64 strings, each at most 256 UTF16 units and 512 UTF8 bytes. JSON text resembling an array remains scalar text. Ingestion preserves only explicit span `tags` arrays; invalid, oversized, or scrubbed populations remain unavailable. Resource and scope composites retain their scalar encoding.

The `filter` query parameter is a JSON object with exactly this closed shape:

```json
{"version":1,"all":[{"field":"model","op":"eq","value":"captured-model"},{"field":"captured_cost_usd","op":"eq","value":0}]}
```

The conjunction permits at most 12 clauses and 8 KiB of encoded JSON. String values permit at most 256 UTF16 units and 512 UTF8 bytes. Unknown fields, operators, duplicate keys, malformed values and duplicate HTTP parameters return an error. Values enter fixed SQL through bound parameters. Equivalent conjunction order produces the same canonical meaning.

| Resource | Local route | Team project route |
| --- | --- | --- |
| Payload-free run summaries | `/api/runs/search` | `/api/team/projects/:project/runs` |
| Captured span excerpts | `/api/runs/search-hits` | `/api/team/projects/:project/search-hits` |
| Model/provider/tag suggestions | `/api/runs/search-suggestions` | `/api/team/projects/:project/search-suggestions` |

MCP exposes `search_runs`, `search_span_hits`, and `search_suggestions`. Suggestions use only captured evidence in the current store/project, permit at most 20 values, and never call a provider. They exclude strings changed by the fixed credential scrubber.

Run summaries retain their payload-free contract. Span hits admit each complete name/input/output field at up to 8 KiB inside SQLite before allocating the worker's result. Raw internal worker transport is capped below 120 KiB across all row text and metadata; fields are never cut to fit. The parent redacts each complete admitted field before producing UTF16-safe excerpts/highlights. Public hits are capped at 50 rows, 4 KiB per row and 120 KiB per response. Missing, oversized, or redaction-rejected fields are explicitly unavailable. React renders excerpt text directly.

Pagination binds the store, resource, canonical query, and Team project. Existing local text-only version 1 cursors remain supported; typed local summary queries use version 2 cursors. Cursors from another store, resource, project or meaning are refused. Search shares a two-worker limit with summary search, holds capacity until each worker exits, and enforces a five-second deadline with cancellation checks between rows. Cancellation does not claim to interrupt a SQLite call already executing.

**Save search** persists only safe submitted canonical queries, at most ten records and 16 KiB in aggregate. A recognized credential excludes the query from history without rewriting its search meaning. Local history uses an opaque store/resource scope in local storage. Team history uses an opaque noncredential session/project/resource scope in session storage. These identifiers are grouping keys; authorization remains server-enforced. No database path or credential is placed in a storage key or scope response.

Team requests check current project authority before and after worker acquisition, scrubbing and publication. Denial, logout and session replacement abort pending views, discard stale suggestions and clear Team histories. A denied or missing project is an error state, distinct from an empty search. Team searches do not fall back to the local profile.
