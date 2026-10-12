# Claude session hooks

Run Phantom's Claude hook components are under development. The source tree has
bounded hook admission, transcript acquisition, normalization, exact-owned
settings operations and unregistered store/controller/management helpers. Daemon
publication and application owner capture consent are not active.
An installed settings entry alone does not establish captured evidence.

The callback command is:

```text
runphantom hooks handle claude --installation-id <32 lowercase hexadecimal characters>
```

Settings use a direct absolute executable plus an argument vector, a three-second
vendor timeout and `onFailure: "continue"`. The callback exits zero with empty
stdout and stderr. It does not start a daemon or provider, inspect credentials or
choose a database. Extra arguments are refused before stdin acquisition. While
authority is inactive, even a valid callback publishes no evidence.

The callback acquires at most 256 KiB of actual stdin bytes and requires EOF within
250 ms. Its overall deadline is 1.5 seconds. Invalid UTF-8, malformed JSON,
duplicate object members, excessive depth and unsupported hook events cannot
become admitted evidence. The early CLI branch loads only the callback's parser
closure; the existing local and team command branches retain their own runtime
selection.

Trusted installer code can merge and remove its exact callback vector through
`updateClaudeSettings`. It preserves unrelated handlers and unknown settings,
refuses edited ownership, uses a cooperative lock, checks the observed settings
snapshot and replaces the target in the same directory. This detects observed
concurrent changes; it cannot promise an atomic filesystem/database transaction
or prevent an arbitrary writer racing the final rename. Malformed settings remain
untouched. Global and local targets must be resolved by trusted management code.

`inspectClaudeHookSettings` reports configuration and executable availability
separately. Its capture policy is `inactive`, transport is `unavailable`, installed
vendor version is unavailable and `captureVerified` is false. It never launches
the executable. Install/uninstall/doctor management dispatch and consent activation
remain pending the same-owner daemon integration.

Transcript acquisition accepts only a bounded regular file under the registered
Claude projects root, with an exact session or subagent filename. Descriptor and
path identity, frozen prefix digest and cursor checks prevent a replaced or
truncated source from silently correcting an earlier observation. The maximum
file is 8 MiB. Long lines, excess records/entities and incomplete tails remain
explicit partial coverage. Mac descriptor controls do not qualify Windows ACLs
or Linux behavior.

Normalization always labels observations as producer-reported and unverified.
`Stop` closes a response claim; `SessionEnd` is a separate session closure claim.
Exact API message IDs own standalone usage observations; session roots have no
usage rollup. Absent counts remain unavailable. Conflicting terminal claims,
unmerged fragments and missing source identity remain explicit.

Metadata mode retains no prompt, argument, result or assistant bodies. Full mode
requires separate explicit local owner installation consent; a payload or settings
flag cannot grant it. The normalizer enforces sensitive-key and known-secret value
redaction before any batch could cross transport, including under ambient allow
exemptions. Raw transcript text is private ephemeral parser input and is never an
export artifact.

The synthetic fixtures and native callback controls qualify these components.
They do not establish a real installed model session, retained Runs output,
daemon restart/delete/import fencing or full application acceptance. Those checks
remain pending activation and the separately authorized provider session.

The unregistered management helper prepares a disabled installation before private
capability and settings writes, then commits active policy only under the same
owner and installation generations. Meaningful policy changes and uninstall revoke
the earlier token; an identical installation preserves it. A private capability
uses mode 0600 under a mode 0700 directory. Full policy is available only for an
explicitly consented local installation. Missing capability, installed settings,
stored policy and unavailable transport are separate diagnostic facts.

The unregistered global management helper accepts an explicit catalog of trusted
existing workspaces and exact vendor project transcript directories. One global
metadata capability covers those registrations; each local full capability stays
separate. Admission requires two consistent hashed matching claims and refuses
unregistered or ambiguous pairs. Those claims register no path and grant no full
policy. The same registered project shares source and usage identities across
global metadata and local full; another project has a distinct source identity.

Catalog data uses a closed versioned object in the existing installation row. Each
entire encoded row is capped at 16 KiB; at most 64 registration occurrences across
all rows count disabled and local authorities as well. Exact duplicate catalog
entries are idempotent. A meaningful catalog change or unregister rotates token
and generation during disabled prepare before capability/settings write awaits.
Read-only canonical registration and settings preflight happens before prepare.
Unregister revokes earlier queued callbacks and preserves retained full evidence
and tombstones. Diagnostics report registration count and `registered_workspaces`
only for explicit catalog coverage, alongside unavailable transport and false
`captureVerified`. No unregistered workspace is discovered automatically.

The store uses an injected owner SQLite connection, synchronous immediate
transactions and actual encoded-state quotas. It checks current token, policy,
owner and installation generations again at publication. Actual canonical span
changes cause refusal rather than restoration from cached hook data. The standalone
HTTP controller admits two active and eight queued requests with finite body and
request lifetimes; closing it aborts and drains owned reservations. It is not
registered in the application server. Tests bootstrap the exact reviewed proposal
DDL in temporary owner databases; that fixture is not an installed migration.

Native owner-database, HTTP and filesystem tests cover these helper boundaries,
including external writer contention, current-policy redaction, quota rollback,
tombstone refusal, paused-body owner changes and settings failure reconciliation.
Application startup ownership, migration integration, callback transport, installed global
metadata coverage and real installed session acceptance remain pending.
The owned lifetime coordination component binds one exclusive listener on
127.0.0.1 at a deterministic port in 40000–49999 derived from the canonical
actual SQLite path. It holds that listener for the owner lifetime and closes
incoming connections without returning data. An occupied port or hash collision
refuses ownership; it never tries another port or consults PID/health hints.
Startup must supply the migrated actual SQLite connection to the coordinator,
which acquires the lease before rotating the owner generation. A released lease
also fences installation commits and capture transactions. An ordinary store
constructed without a live owner guard stays inactive; test-only SQL fixtures
explicitly supply their own guard. Central startup/routes are still inactive.
Shutdown must drain the controller and close the database before releasing the
lease; the lease helper alone does not coordinate those application resources.
