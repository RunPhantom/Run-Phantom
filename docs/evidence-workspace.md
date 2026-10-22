# External report workspace

Run Phantom's **Evaluations → External reports** workspace attaches supplied test
reports to existing captured work. It shows the report's observations, missing
sources, immutable interpretation and verification limits beside the original
work. Imported reports never replace a saved check or experiment verdict.
Run Phantom is maintained by Divyam Talwar.

The regression workbench remains the default Evaluations view. This workspace
uses current local run, inspection, saved-check and frozen-experiment identities.
An absent or removed anchor is refused; it does not create work from an arbitrary
identifier. Project roles and private team databases are a separate integration.

## Import a report

1. Choose a context type and an existing attachment. Saved report history shows
   the newest 50 report sets, with an explicit truncation notice. Choose a set and
   an explicit revision to review immutable history.
2. Review or declare the expected source roster independently of your files.
   Every expected entry has a shard, report kind and optional runner, commit and
   digest constraints. Saving uses the displayed revision as a compare-and-swap;
   a stale draft is refused and retained until you explicitly load the current
   roster.
3. Choose 1–32 local files, with at most 2 MiB per file and 8 MiB combined. Review
   each generated source ID, finite format and optional shard claim. Filenames
   stay in the local selection UI and are not sent as report identities. Paths
   and URLs are not accepted. All selection limits are checked before reading or
   hashing any file; preparation reads and hashes one file at a time.
4. Leave raw retention disabled for normalized observations only. Enable
   **Retain raw bytes** deliberately if this revision needs exact raw download or
   later reparse. Raw files can contain private data that the minimized exports
   omit.
5. Select **Import reports**. An accepted upload is an admission receipt, not a
   passing-test result. The operation remains queued or running until publication;
   observations are shown only for a persisted revision. Worker failure can leave
   observations unavailable even when its declared source roster is known.

Supported selections are JUnit XML, a reviewed in-toto test-result statement,
a DSSE envelope, or JSONL containing exactly one DSSE envelope. The exact registered
reader, content contract and limits come from the daemon's capabilities endpoint.
Unsupported versions, malformed contents, contradictory leaves and unverified
signatures stay explicit. There is no generic arbitrary report-JSON reader.

A retrospective roster declared after capture cannot establish complete expected
coverage. To prepare prospective experiment coverage, choose **Plan a dataset
roster**, save the full roster for the exact dataset revision before starting the
experiment, then choose that experiment's **Frozen dataset revision** inventory
source. Its frozen dataset identity and hash must match. A roster created after
that experiment is refused for prospective binding. Editing any roster cannot
rewrite the original experiment or an earlier report interpretation.

## Interpret the output

A source outcome, expected-source coverage and authenticity are separate facts.
A definite report failure remains visible even when another source is unknown or
missing. **No tests** means observed empty execution, with known zero counts; it
is not a pass. Missing observations show **Unavailable**, while known executed
lower bounds stay separate from exact execution totals. Counts are exact decimal
strings rather than rounded JavaScript numbers.

Attestation test lists and producer counts are assertions. They never add executed
leaves. A claimed report digest can link only to an exact report within this same
authorized set. **Report identity asserted**, **Commit assertion match** and
**Authenticity: Not checked** remain separate; a fake signature does not prove
execution. Source details are escaped text, and sensitive details follow the
registered normalization policy. Normalized content can still contain private
names or details, so review it deliberately.

## Recovery, history and privacy

The URL records only anchor, set, revision and operation locators. It does not
store report bytes or credentials. Reloading reads fresh server authority rather
than relying on browser storage. If an attachment disappears or the current read
is refused, the prior report body is hidden and the error remains visible.

**Recover operation** finds the original durable operation after an interrupted
receipt. Cancellation of preparation/upload and **Cancel operation** are separate
controls. A cancelled operation cannot publish later; a completed revision cannot
be cancelled retroactively. **Start new operation** creates a distinct attempt and
resets raw-retention opt-in. The workspace never silently retries under a new key.

**Export JSON**, **Export JUnit**, **Export text** and **Copy minimized summary**
use the same minimized projection, keeping source identities, coverage, observed
counts and unchecked trust. They omit raw bytes, leaf names/files/details and
producer test-name lists. Revision metadata may still contain producer subject
names, explicit source IDs and digests. JUnit export is refused when the leaves
cannot be classified completely; it does not fabricate passing observations.

**Separate raw download** requires choosing a retained source and uses its separate
server capability. **Reparse retained bytes** appends a new interpretation using
this set's own raw bytes and the current registered reader; it never substitutes
another set's matching digest. The prior revision remains unchanged. The current
reader reparsing itself does not establish support for a second reader version.

**Remove raw bytes** and **Remove normalized content** each require an explicit
confirmation for the selected revision. Keeping content is initially focused and
Escape dismisses the confirmation. Removing raw bytes disables its download and
reparse while preserving normalized interpretation. Removing normalized content
removes detailed leaves while preserving the immutable observed summary. Content
in a later revision remains independent. These availability distinctions survive
daemon restart.

## Local discovery and qualification boundaries

History discovery uses current exact attachment authority and scope generation
inside one database transaction. It first inspects SQL-byte-guarded job metadata
of at most 64 KiB per row to identify an attachment. Matching head discovery is
refused above 1,000 heads, 32 MiB aggregate set metadata or the 4 MiB per-set limit,
before inspecting set payload JSON. Unknown, malformed or oversized candidate
metadata is refused explicitly rather than presented as an empty history. Known
unrelated anchors do not consume that attachment's aggregate budget. This is not
a claim that the entire database scan has a global row cap. Successful responses
contain only `id`, `revision`, `createdAt`, at most 50 entries and `truncated`, within
128 KiB. Selected revisions still use the canonical digest-checked store read.

The owned workspace uses the V1 cobalt/white palette, licensed self-hosted Syne
headings and existing Inter text. Its controls support keyboard focus, native file
selection, touch targets, reduced motion and narrow layouts. Browser checks use
actual migrated storage, report workers, real HTTP bytes and persisted output;
touch emulation and a 200% CSS zoom/reflow probe are distinct from native browser
zoom qualification. The full global shell/theme composition remains separate.

Current daemon measurements expose wall-clock acquisition, queue, worker lifetime,
publication and total operation timing. Worker lifetime includes process startup
and teardown, not just parsing. These timings become unavailable after restart;
CPU and RSS remain unavailable. Durable decode/parse/normalize clocks, project
role integration, finding comparisons, a second registered reader, cross-version
rollback and native-platform qualification are separate gates. See
[evidence import contract](evidence-import.md) for the exact wire and lifecycle
rules. Source browser checks do not replace copied-application qualification.
