# External evidence import

Run Phantom imports supplied report bytes into an existing local run, inspection,
check or experiment. It records what each report contains without treating the
upload, producer assertions or an unverified signature as proof that a test ran.
This service preserves original experiment results. Divyam Talwar maintains
Run Phantom.

The API is under `/api/evaluations/evidence`. Existing socket, host, origin and
local-origin checks apply to every endpoint. The daemon creates one local owner,
one import coordinator and one subprocess supervisor. Each future project owner
must supply its private authoritative database and current transaction-bound
authorization; the generic service never chooses a local database for a team.
Project routes and roles are a separate feature.

## Discover the registered reader

`GET /capabilities` returns the exact `reader` identity (`parserVersion`,
`policyVersion`, `configurationSha256`), transport limits and supported dialects.
Use this identity in new import requests. The current parser is
`runphantom-report-reader/1`, with policy `redaction/v1`. An unregistered parser,
policy or configuration is refused. Reparse uses the currently registered reader;
a second parser version has not been activated.

Reviewed dialects are JUnit XML (`junit-xml/v1`), a bare in-toto statement
(`in-toto-statement/v1`), a DSSE JSON envelope (`dsse-envelope/v1`) and a JSONL file
containing exactly one nonblank DSSE envelope (`dsse-envelope-jsonl/v1`).
Attestations require `_type=https://in-toto.io/Statement/v1` and
`predicateType=https://in-toto.io/attestation/test-result/v0.1`; envelopes require
`payloadType=application/vnd.in-toto+json`. These dialect names identify selected
Run Phantom reader contracts. Generic test-report JSON schemas are not admitted.

## Streaming binary transport

`POST /imports` accepts only
`Content-Type: application/vnd.runphantom.evidence-import.v1+octet-stream`.
It is the sole binary exception to the existing evaluation and verification JSON
middleware. Compression is refused. Uploads contain these consecutive bytes:

1. Four unsigned big-endian bytes giving the metadata byte length, from 1 to
   65,536.
2. Exactly that many UTF-8 bytes of strict JSON: `{"version":1,"request":...}`.
3. Each declared source's exact bytes, in descriptor order. No separators,
   trailing bytes, extra source or filename/path/URL fields are accepted.

Metadata must be ordinary strict JSON, with no duplicate keys, prototype keys,
unknown fields or unsafe numbers. The request fields are:

| Field | Meaning |
| --- | --- |
| `operationKey` | Client-chosen bounded operation identity, scoped to this owner's current generation |
| `attachment` | `{kind:"run"|"inspection"|"check"|"experiment",id}` identifying a current authorized row |
| `target` | `null` for an initial set, or `{setId,expectedRevision}` for an append with compare-and-swap |
| `inventory` | `null`, or `{id,revision}` from an authorized inventory endpoint |
| `parserVersion`, `policyVersion`, `configurationSha256` | Exact values from `/capabilities` |
| `retention` | `raw_and_normalized` or `normalized_only` |
| `sources` | An ordered array of 1–32 descriptors |

Each descriptor contains `sourceId`, `kind`, `dialect`, `shardId` (string or null),
`artifactSha256` (64 lowercase hexadecimal digits) and `byteLength`. `kind` is
`junit`, `json`, `jsonl` or `attestation`, consistent with its reviewed dialect.
The request cannot supply filesystem paths, URLs or an expected-source roster.
Actual source bytes must match the exact length and SHA-256 digest.

For example, obtain `reader` from discovery, build a request for an existing run,
then encode the frame:

```ts
const bytes = new TextEncoder().encode(reportText);
const request = {
  ...reader,
  operationKey: crypto.randomUUID(),
  attachment: { kind: "run", id: existingRunId },
  target: null, inventory: null, retention: "raw_and_normalized",
  sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1",
    shardId: "unit", artifactSha256: digest, byteLength: bytes.byteLength }],
};
const header = new TextEncoder().encode(JSON.stringify({ version: 1, request }));
const frame = new Uint8Array(4 + header.byteLength + bytes.byteLength);
new DataView(frame.buffer).setUint32(0, header.byteLength, false);
frame.set(header, 4); frame.set(bytes, 4 + header.byteLength);
await fetch(`${base}/api/evaluations/evidence/imports`, {
  method: "POST", headers: { "Content-Type": transport.contentType }, body: frame,
});
```

`digest` is the lowercase SHA-256 of `bytes`, never a producer-declared digest.
The client must enforce discovery limits before allocating its frame. Chunked
HTTP requests are supported. A supplied Content-Length must be valid and equal
the calculated frame length; actual stream limits remain authoritative.

The daemon checks current attachment and inventory authority before reserving
storage or acquiring source bytes. Header and source sizes are checked before
allocation. Sources are limited to 2 MiB each and 8 MiB combined. The maximum
wire frame is 8,454,148 bytes, including the largest metadata header and prefix.
Parsing allows at most 50,000 observed leaves and 4 MiB of normalized publication
per import. The fixed operation deadline is 15 seconds from admission into the
coordinator, including metadata, queueing, acquisition, worker and publication;
each source acquisition and worker lifetime is bounded by 2 seconds. Continued
chunks do not reset deadlines. Abort, malformed bytes and timeout release the
reservation without retaining a raw partial upload.

## Capacity, durable identity and cancellation

One daemon admits at most two active imports and eight queued operations,
including paused source acquisition. Metadata acquisition also shares the
bounded ten-entry owner. Storage admission may refuse earlier: the default
local quota is 64 MiB raw and 32 MiB normalized. Each pending import reserves
up to 4 MiB normalized, so eight pending reservations fill an otherwise empty
default normalized quota. Existing retained data reduces available admission.
The scheduler maximum does not promise ten imports will fit storage.

A successful capture returns HTTP 202 with `{job,reused,timings}`. This is an
admission receipt. Poll `GET /imports/:jobId` for the terminal state and declared
source roster, or `GET /imports?operationKey=...` to recover an interrupted
acknowledgement, including while an upload is queued. A complete publication
returns `status:"completed"` and `setId`. Failed worker operations can have no
set; the declared roster remains visible, with observations unavailable.

An identical same-key request reuses the durable operation and never appends a
second interpretation. Changed configuration, inventory, target, retention or
source descriptors conflict with HTTP 409. Retries must still provide exact
declared raw bytes. A failed or cancelled operation keeps its identity; use a new
operation key for a new attempt. A durable retry may reuse its originally frozen
inventory after a later authorized edit; a new import requires the current head.

`POST /imports/:jobId/cancel` with `{}` atomically fences the job, releases its
reservation, cancels every in-flight receipt for that operation, and awaits actual
worker exit. Cancellation cannot rewrite completed work. Upload, queue, worker,
timeout, shutdown and lost-attachment failures use closed sanitized codes and
remain distinct from user cancellation. Publication rechecks current authority,
attachment, scope generation, job token, nonterminal state and target revision
in one immediate transaction. Stale processes cannot resurrect cleared work.

Startup marks owned unfinished work `restart_interrupted` and releases its
reservations. Normal run deletion invalidates active run/inspection/check imports
before unlinking their anchors. Clear-all rotates the owner generation. Shutdown
stops admission, aborts live acquisition, kills and awaits real workers, closes
live sockets, and awaits server close. Current experiment/check retention protects
active attachments in its existing insertion transaction, refuses a full protected
retention pool, and blocks eviction if active request metadata is corrupt.
Synchronous replay/demo deletion refuses active run, inspection or check
attachments before deleting their rows. Replay promotion and multi-fixture demo
reset use database transactions, so refusal also rolls back earlier metadata,
annotation and fixture-deletion changes. Cancel the import before retrying these
synchronous operations.

## Authorized inventories and coverage

`POST` or `PUT /inventories` accepts `{anchor,expectedRevision,expected}`.
`expectedRevision:0` creates an inventory; subsequent edits compare-and-swap its
current revision. `GET /inventories?anchor=<encoded-json>&revision=N` reads an
explicit authorized revision. Omitting `revision` reads the current authorized
head. An anchor is a current attachment or
`{kind:"dataset_revision",id,version}`. Each expected entry is
`{shardId,kind,constraints:{runnerId,commit,sourceSha256}}`, with absent constraints
represented by null. Upload metadata cannot edit or shrink this roster.

A dataset-revision roster declared before an experiment can bind only to that
experiment's exact frozen dataset revision/hash. Inventories declared against an
already existing run/check/inspection/experiment are retrospective and retain
incomplete coverage. No inventory gives `not_declared`, even when a report passes.
Missing, extra, duplicate, rejected and mismatched sources remain explicit.
An inventory revision edit never rewrites a prior set or the original experiment.

Producer counts and assertions remain separate from observed leaves. Counts use
exact decimal strings; unknown or contradictory leaves prevent exact executed
counts. A definite report failure remains visible even with missing sources or
other unknown reports. Attestations never contribute executed leaves. An exact
digest assertion can link only its report in this authorized set; sibling reports
remain unlinked. `reportIdentityAsserted`, `commitAssertionMatches` and
`authentication:"not_checked"` are separate. Fake signatures do not authenticate
execution.

## Read, export, reparse and retention

| Endpoint | Result |
| --- | --- |
| `GET /sets?attachment=<encoded-json>` | Current authorized head locators, at most 50 plus explicit truncated; no report bodies |
| `GET /sets/:id?revision=N` | Immutable set metadata and currently available normalized observations |
| `GET /sets/:id/export?revision=N&format=json` | Minimized JSON without raw bytes, leaf detail/name/file or producer test-name assertions |
| `GET /sets/:id/export?revision=N&format=junit` | Classified observed leaves with explicit coverage and unverified properties; 409 if observations cannot be classified completely |
| `GET /sets/:id/export?revision=N&format=text` | Plaintext from the same minimized DTO, preserving unknown counts and unchecked trust |
| `GET /sets/:id/raw/:sourceId?revision=N` | Separate `raw_export` capability; exact supplied bytes as an attachment |
| `POST /sets/:id/reparse` | `{operationKey,expectedRevision,inventory?,retention?}`; append using this set's own retained bytes and registered reader |
| `DELETE /sets/:id/retention/raw?revision=N` | `{}`; remove only raw availability, preserving prior normalized interpretation |
| `DELETE /sets/:id/retention/normalized?revision=N` | `{}`; remove only normalized payload availability, preserving immutable summary metadata |

All JSON controls are capped at 64 KiB and every endpoint sends `Cache-Control:
no-store`. Raw deletion prevents later download or reparse of that revision,
including after restart. Another set containing the same digest does not restore
availability. Reparse compare-and-swap prevents stale appends. A raw or normalized
retention change fences affected nonterminal reparses. Worker/process failures
cannot return partial parser observations; that state is explicitly unavailable.
Successfully returned malformed sibling observations remain unknown rather than
being converted to passing evidence.

The `eval_evidence` MCP tool uses these same routes and frame transport. Its closed
actions cover import, status, cancel, inventory read/edit, minimized report, explicit
raw export, reparse and retention deletion. Import accepts ordered bounded base64
source bytes; it validates encoded lengths before decoding. It accepts no caller
URL or path. An import-only project credential will need the separately implemented
project capability mapping; local service access does not establish that claim.

## Timing and qualification boundaries

Job status exposes bounded measurements made by the current daemon:
`acquisitionWallMs`, `queueWallMs`, `workerLifetimeWallMs`, `publicationWallMs` and
`totalOperationWallMs`. Unfinished or unmeasured stages are null. CPU and RSS are
always null. These measurements are bounded in memory and become unavailable
after a restart; durable jobs and report interpretations remain available.
Worker lifetime includes subprocess startup and teardown and is never labeled
parser duration. Separate durable decode, parse, normalize, inventory and UI
clocks remain an RX12 follow-up.

Source HTTP, actual MCP, real process cleanup and file-backed restart tests cover
this service. The [external report workspace](evidence-workspace.md) adds real local
file upload, current inventory editing, source review, minimized exports and
separate retention controls. Project middleware/roles, finding comparisons,
a second registered parser, rollback across installed versions, and native Windows
signal behavior have separate qualification gates. Existing UI smoke journeys
alone do not prove an evidence-upload UI. Installed checks must execute the copied
application outside the checkout with its actual embedded worker and migrations.
