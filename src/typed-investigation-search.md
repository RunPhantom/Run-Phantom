# Typed investigation search

Open **Search** for a local profile, or **Traces** in a private Team project. Keep the existing text, status, model and provider controls, then open **Advanced filters** to add captured conditions. Choose **Matching spans** to inspect safe input/output excerpts and open the original captured step. Enter in the value input adds a condition; the chips remove conditions, and Undo/Redo restores recent in-memory edits.

Every model, provider, duration, captured cost and tag condition must match the same captured span. A run containing a model on one step and a provider on another does not satisfy both. Run status applies to the containing run. Text searches treat quotes, SQL-looking text, `%`, `_` and Unicode as literals; ASCII letters fold case, while Unicode keeps SQLite's literal comparison behavior.

| Field | Values | Operators |
| --- | --- | --- |
| `status` | `running`, `completed`, `failed` | `eq`, `ne` |
| `model`, `provider`, `tag` | Exact captured string | `eq`, `ne` |
| `duration_ms`, `captured_cost_usd` | Finite nonnegative number | `eq`, `ne`, `lt`, `lte`, `gt`, `gte` |

Captured cost uses reported exporter cost, with the first present supported alias retaining authority. Missing, malformed, duplicated, or unavailable evidence proves neither zero nor absence. Explicit zero remains valid. Tags require a complete captured array: at most 64 unique strings, each at most 256 UTF16 units and 512 UTF8 bytes, without ASCII controls. JSON text resembling an array remains scalar text. Ingestion grants population authority only to exactly one explicit span `tags` occurrence without dropped span attributes. Duplicate occurrences, duplicate members, invalid, oversized or unavailable populations remain unavailable. Resource and scope composites retain their scalar encoding, and original ordered source attributes are not rewritten.

Categorical admission is conservative for both ingestion and stored/imported arrays. One rejected member excludes the entire population from equality, inequality and suggestions; a retained safe subset cannot prove membership or absence. Safe categorical Unicode, quotes, literal `%` and `_` keep exact matching. Empty original arrays can prove absence; missing or incomplete populations cannot.

The closed carrier exclusions are embedded case-insensitive `[REDACTED]`, `[UNAVAILABLE]`, `[TRUNCATED]`, `[UNSERIALIZABLE]`, `[CIRCULAR]` and `__REDACTED__` markers; recognized credential prefix/alphabet/minimum families; JWT-shaped three-part carriers; Team tokens with their 16-character minimum; Bearer/Basic carriers with at least eight token characters; authorization, proxy-authorization, x-api-key, api_key/api-key/apikey, password, cookie and set-cookie assignments; any HTTP(S)/WS(S) URL-looking substring; and strings starting with `[`, `{` or a double quote after whitespace. Even benign URL/JSON-looking legacy members are explicitly unsupported and make the population unavailable. These fixed bounded native predicates are categorical admission, not an exact general redactor or URL/JSON credential parser. They never truncate members, parse raw capture payloads in workers or turn refusal into a nonmatch proof.

Credential families retain their fixed minimums: `sk_live_`/`sk_test_`/`rk_live_`/`rk_test_` (10 alphanumeric characters); `sk-ant-`/`sk-proj-`/`sk-svcacct-`/`sk-admin-` (20 alphanumeric, underscore or hyphen characters); `AKIA`/`ASIA` (16 uppercase alphanumeric characters); `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` (20 alphanumeric characters); `github_pat_` (22 alphanumeric or underscore characters); `AIza` (35 alphanumeric, underscore or hyphen characters); `xoxb-`/`xoxa-`/`xoxp-`/`xoxr-`/`xoxs-` (10 alphanumeric or hyphen characters); and `ya29.` (20 alphanumeric, dot, underscore or hyphen characters). JWT-shaped refusal requires `eyJ` followed by at least four base64url characters and two later dot-separated segments starting with at least four base64url characters. Carrier refusal may conservatively cover additional text around these shapes. Historical loss already erased by a parser cannot be recovered from a surviving ordinary array.

Original JSON is observed before the existing parser can erase duplicate tag-carrier keys. Escaped aliases, reversed property order, repeated span dropped-attribute declarations and ambiguous ancestor arrays make only the affected descendant tag populations unavailable. Critical key decoding permits at most 128 decoded UTF16 units and 768 raw string-content characters, accounting for fully escaped spellings and excluding quotes. Request-local annotation retains schema indices and flags, never raw payloads or credentials; it is consumed once and does not rewrite source objects. Unrelated duplicate attributes and JSON-looking business strings keep their existing behavior. Existing expanded-body limits remain 50 MiB locally and 1 MiB for Team, including gzip. The targeted scan permits depth 64, 250,000 tokens and 10,000 unavailable paths; exhaustion or uncertain charset observation leaves all tag populations in that request unavailable while other fields retain their existing parsing behavior. It creates no second value tree and does not replace syntax or lossless numeric validation.

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
