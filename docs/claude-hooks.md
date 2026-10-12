# Claude session hooks

Run Phantom's Claude hook components are under development. The source tree has
bounded hook admission, transcript acquisition, normalization and exact-owned
settings operations. Daemon publication and owner capture consent are not active.
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
