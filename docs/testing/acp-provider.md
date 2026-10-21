# Native ACP coding sessions

Run Phantom can select an installed protocol-1 coding agent alongside its existing
coding providers. The selected provider launches in the current canonical
workspace, streams typed text/tool/plan updates, and keeps only the conversations
created by this daemon. It can resume those sessions when the native agent
advertises session loading. This does not enumerate an external native history.

An initialize response means the protocol is available. It does not verify sign-in
or prove that a model can answer. The UI keeps authentication unknown until a
native operation reports a specific authentication failure. Run Phantom does not
run login, retry authentication, or grant ACP client filesystem/terminal access.
Permission requests are denied. Unsupported updates retain only a bounded type
marker and make capture incomplete.

The workspace selection includes the physical state-file and directory identity.
A replacement, concurrent selection change, provider transition, cancellation or
disconnect invalidates the operation. Workspace/provider transitions join native
work before publishing new state; shutdown closes admission permanently and joins
owned work before releasing its HTTP/WebSocket and verification peers.

## Optional application verification

When the selected run has exactly one connected application session, the current
focused UI view can issue an ephemeral verification grant to that native session.
Its MCP child offers only `app_observe` and `app_assert`. The application target,
run, document generation, selected workspace and provider epoch are fixed by the
daemon. Callers cannot supply a URL or session target. Changing focus, replacing
the document, disconnecting or changing workspace/provider revokes this authority.

The grant expires after 45 seconds. It permits eight calls, at most two admitted
calls globally, a 16 KiB frame, 64 KiB total input and 64 KiB total result output.
There is no queue or retry. Strict raw JSON validation precedes normal MCP parsing;
duplicate keys, unsafe integers, malformed UTF-8 and incomplete frames are refused.
The limited child closes on EOF/error and bounds both HTTP and stdout waits. Large
results fail explicitly; they are not shortened into successful verification.
Ordinary Run Phantom MCP registration remains independent.

Assertions use the existing application verification service and persist its real
pass/fail/inconclusive report. An assertion already in progress may retain an honest
inconclusive report after disconnection; the revoked grant cannot return that report
as a successful answer. Offering a tool is separate from proving a native provider
actually invoked it.

## Verification boundaries

The permanent tests cover actual owned ACP subprocesses, protocol failures,
cancellation, session/message/content limits, workspace/provider races, HTTP and
WebSocket shutdown, and annotation export/import identity. Mechanism tests for
nonce/capacity/stdio rules use an explicitly controlled service.

The browser journey pairs a real Chromium document with the original application
SDK. A controlled ACP process launches the real Run Phantom MCP CLI and invokes its
real MCP SDK tools. The existing verifier produces persisted pass and fail reports,
and a disconnect control retains an inconclusive report while refusing the revoked
native answer. The UI renders those reports. This is real MCP/application grading
with a controlled ACP provider; it is not an authenticated model response.

```sh
bun test tests/acp-sessions.test.ts tests/acp-mcp.test.ts tests/acp-http.test.ts
bun x tsc --noEmit
bun x tsc --noEmit -p app/tsconfig.json
bun run lint
bun run build
cd app
node node_modules/@playwright/test/cli.js test tests-e2e/acp-provider.spec.ts --workers=1 --retries=0
```

The mounted browser tests exercise selection, native response, cancellation and
resize from desktop through 320 px. They wait for current protocol status, settled
text and panel geometry before capturing evidence. Native initialize, a controlled
provider and a real authenticated model answer are distinct qualification cells.
An actual paid native-provider response, installed-provider tool permission behavior
and native Windows process-tree behavior require their own bounded execution proof.
