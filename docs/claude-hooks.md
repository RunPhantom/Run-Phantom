# Claude session hooks

Run Phantom can collect bounded Claude session observations through ordinary
hooks. Setup installs metadata capture by default. Full body capture requires
explicit consent for a local workspace:

```sh
runphantom setup --global
runphantom hooks install claude --global --cwd /absolute/project
runphantom hooks install claude --local --cwd /absolute/project --full --consent-full
runphantom hooks doctor claude --local --cwd /absolute/project
runphantom hooks unregister claude --global --cwd /absolute/project
runphantom hooks uninstall claude --local --cwd /absolute/project
```

A global settings target covers the workspaces explicitly registered through
management. Repeating global installation for another workspace adds it to that
catalog. It does not discover or grant an unregistered workspace. One global
metadata capability and each separately consented local full capability remain
distinct. Global full capture is unavailable. Doctor reports the settings target,
registered coverage, current policy, private capability and transport separately.
`captureVerified` remains false: installed configuration and an available transport
do not prove an actual model session was captured.

The installed callback vector contains an absolute executable and these arguments:

```text
hooks handle claude --installation-id <opaque ID> --capability-file <absolute private file>
```

There is no credential in argv or settings. The private descriptor binds the
installation, canonical owner identity, token, current generations and one fixed
numeric loopback origin. It must be an owned 0600 regular file in an owned 0700
parent, with canonical nonsymlink ancestors, O_NOFOLLOW and descriptor/current-path
checks. Its acquisition is limited to 16 KiB and 250 ms. A disabled descriptor has
null token, generations and origin. Management while the daemon is unavailable
installs inert configuration; full flags alone cannot activate daemon consent.
Management refuses a daemon belonging to another actual database profile.

Callbacks always exit zero with empty stdout and stderr. Malformed extra arguments
are refused before stdin or filesystem acquisition. Stdin must reach EOF within
250 ms and fit 256 KiB; the complete callback lifetime is 1.5 seconds. The callback
never starts a daemon/provider, selects a database/profile, uses an ambient URL,
follows redirects or borrows another workspace's capability.

The actual daemon authenticates the current capability and selects exactly one
registered workspace/project pair before transcript bytes are acquired. Hook cwd
and path values are matching claims, not registrations or full policy grants. The
transcript must be a current bounded regular descriptor under that trusted project
root; symlinks, replaced descriptors and another project's path refuse capture.
Transcripts are capped at 8 MiB, lines at 256 KiB, records at 5,000, entities at 128,
each entity at 16 KiB and transport at 256 KiB. Raw transcript text stays private
and ephemeral. Mandatory sensitive-key and known-secret redaction runs before
transport, including under full consent and ambient redaction exemptions.

Metadata retains no prompt, argument, result or assistant body. Exact message
identities retain usage once, without root rollups. Stop is a turn claim;
SessionEnd is a separate session closure claim. SubagentStop advances only the
registered main transcript and retains an advisory producer-reported subagent
terminal claim; its independent agent path never contributes a cursor or body.
Independent subagent transcript capture remains pending a separate bounded source
model. Observations remain producer
reported, runtime unverified and explicitly partial. Conflicts and absent source
identity or counts remain visible rather than inferred as success or zero.

Startup migrates the actual owner SQLite connection before acquiring one exclusive
loopback lifetime lease derived from its canonical path. The lease port lies in
40000–49999, returns no endpoint data and never falls back to another port. An
occupied port or hash collision refuses ownership before generation rotation or
public listening. PID files and health responses are not ownership authority.
Raw callback routes precede general JSON parsing. Two requests may acquire bodies
and eight may queue; every reservation has finite byte and time limits.

Publication rechecks token, catalog membership, owner/installation generations,
source cursor and canonical projection inside the same synchronous SQLite
transaction. Modified canonical spans refuse cached restoration. Meaningful
policy/catalog changes and unregister revoke queued old callbacks before settings
write awaits. Identical installation preserves its token. Catalog rows are each
limited to 16 KiB and all active/disabled/global/local rows together allow at most
64 registration occurrences; SQL encoded state is capped at 32 MiB.

Clear revokes before asynchronous work, drains hook requests and preserves source
epochs and suppression tombstones. Its deletion transaction rotates the generation
before deleting canonical rows. Late callbacks cannot recreate cleared/deleted
runs. Shutdown revokes current authority, drains owned requests and management,
closes the server and actual database, then releases the lifetime lease. Uninstall
revokes stored policy before removing exact owned vectors; unknown handlers are
preserved. Cleanup failure preserves the binary and state for retry.

Native filesystem/HTTP/installed-vector tests exercise these source components,
including two actual database boots and global metadata/local full isolation.
They use synthetic transcript records and do not establish real paid-session
acceptance. The separate real installed session check and copied release
qualification remain pending.
