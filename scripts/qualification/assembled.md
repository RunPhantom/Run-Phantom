# Assembled qualification

F45 collects exact-source stage evidence. It does not turn feature delivery, commit counts, component controls or cross-compilation into installed product acceptance.

The fixed contract contains all 50 F00–F49 units, all 49 F45 prerequisites, R01–R32, RX01–RX12, AD-01–AD-15, five native OS/architecture profiles, three installed browser engines per host, selected provider proofs and enabled/disabled assembled profiles. `createManifest` leaves feature revisions and collected test rosters unresolved. Populate and freeze them, expected output digests, and each host/mode artifact/runtime/resource/database profile before executing a stage. Database pins include the application connection's engine version, source ID, journal mode, synchronous level, foreign keys and busy timeout. Independent review must check the current engine advisory/backport evidence; a broad version-range comparison is not a patched-runtime proof. A caller cannot remove a contract, dependency, feature or selected matrix cell.

Run commands from the pinned clean checkout with an existing runtime, without installing dependencies:

```sh
bun --no-env-file --no-install scripts/qualification/assembled.ts plan --output=/private/run/manifest.json
bun --no-env-file --no-install scripts/qualification/assembled.ts host --output=/private/run/host.json
bun --no-env-file --no-install scripts/qualification/assembled.ts execute --manifest=/private/run/manifest.json --command=/private/run/command.json --output=/private/run/stage-attempt
bun --no-env-file --no-install scripts/qualification/assembled.ts check --manifest=/private/run/manifest.json --bundle=/private/run/bundle --submissions=/private/run/submissions.json --output=/private/run/result.json
```

`command.json` contains exactly `cellId`, `command` (absolute executable plus literal arguments, no shell expansion), `timeoutMs` (at most 30 minutes), and `scope` (`control` or `product`). Stage execution refuses dirty/mismatched source, unfrozen rosters, another host, and provider execution. A separate budget owner must produce actual metered provider evidence. Commands are explicitly reviewed local inputs; evidence ingestion never executes an artifact or a receipt command.

The executor passes a scrubbed private HOME and temporary directory, plus `RUNPHANTOM_QUALIFICATION_OBSERVATION`. The stage writes its observation to that path using the `Receipt` contract. Artifact paths are relative to the new stage output directory. The executor supplies actual source, host, process result, timestamps, bounded raw log and cleanup facts rather than trusting child-reported exit/host fields. It uses the existing native process ownership/teardown helper; timeout and catchable interruption remain failures. Raw logs and real paths belong in private evidence. No receipt is sanitized into a replacement passing result.

The outer controller must acquire its actual checkout/global resource lease and any selected browser lease, impose a finite parent deadline, retain the owned-process registry and reap registered actors before releasing leases, including on parent exceptions. A SIGKILL cannot run a process's finally block. The registry and inherited process identity helper support supervision; this runner makes no universal crash-cleanup claim.

`submissions.json` is an array of `{path, sha256, bytes}` for receipt files under the bundle. Exact duplicate JSON keys, lossy numbers, escaped-key aliases, traversal/symlink escape, changed artifacts, stale source/tree/manifest, duplicate or missing cells, failed/skipped/uncollected/retried nodes, wrong stages/hosts, absent DB/restart/resources/outputs or unconfirmed cleanup fail closed. The manifest's frozen roster is authoritative, not a receipt's self-selected denominator. Artifacts and output digests are checked; installed cells require application-observed DB settings and genuine restart/installed-resource evidence. Source inspection from another DB connection is not a live application-engine proof.

Integrity checks cannot authenticate a remote native host or demonstrate assertion truth from JSON alone. Final acceptance additionally requires independently approved exact receipt/source/host/stage bindings in an explicit `--reviews=/private/reviewer/reviews.json` input outside the evidence bundle. This is a trusted operator input, not a self-attestation field. Review must inspect original runtime/test outputs and host provenance; a supplied review file is not a cryptographic identity claim. Tests deliberately show that a complete manufactured control bundle can satisfy checks-only while remaining unqualified. `--checks-only=true` can return zero only for complete integrity/roster checks; it never sets `releaseQualified`. Normal checks return nonzero unless every selected cell, dependency and independent review is accepted. Stage counts remain separate.

The optional `probe` (explicit DB path) and separate `probe-default` (no DB override, HOME-derived database) actions require an explicit native artifact digest:

```sh
bun --no-env-file --no-install scripts/qualification/assembled.ts probe --binary=/private/build/runphantom --sha256=<64-hex> --output=/private/run/default-installed-probe
```

It checks artifact format/architecture/digest, copies the executable outside the checkout into an empty working directory, launches the real default backend with an isolated profile/DB, asserts real health/import/export/malformed refusal and embedded HTML, closes the first owned process, restarts against the same DB, compares actual exported data, and verifies final teardown/artifact identity. This is a diagnostic observation, not a full installed cell: missing live application runtime/SQLite settings, selected workers/resources, migration/rollback, engines and providers remain explicit. It never substitutes the launcher's runtime version for the application's version, a fresh DB for a populated upgrade, or HTML availability for browser execution.

`probe-default` starts from fresh HOME/USERPROFILE and empty CWD without a DB or secret-store path override. It observes the actual created default database file and native open descriptor where supported, then compares device/inode/path and real exported content across the two public `serve` boots. Existing explicit-path results remain separate. Native descriptor observation unavailable on a host is named coverage loss; it cannot become full native/default-path acceptance.

Aggregation memoizes successful artifact checks only within that invocation, retaining at most 16 MiB and 4,096 cache entries. It then freshly rehashes every unique artifact/path binding without the cache before returning; a changed binding blocks the result and clears valid/accepted stage counts. Direct receipt validation has no cross-call cache.
