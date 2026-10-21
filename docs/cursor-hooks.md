# Capture Cursor session observations

Cursor native hooks can send bounded session, prompt, completed-tool and assistant observations to a running local Run Phantom daemon. This adapter currently supports the POSIX private-capability contract. Native Windows ownership and an authentic installed Cursor session remain unqualified. Synthetic vendor fixtures and source-daemon/browser checks are not evidence of a real vendor session.

Register a workspace with metadata-only capture:

```sh
runphantom hooks install cursor --local --cwd "/absolute/workspace with spaces"
runphantom hooks doctor cursor --local --cwd "/absolute/workspace with spaces"
```

Full body capture requires explicit workspace-local consent:

```sh
runphantom hooks install cursor --local --cwd "/absolute/workspace with spaces" --full --consent-full
```

Global registration uses `--global --cwd PATH` and remains metadata-only. Each global workspace must be explicitly registered. `unregister cursor --global --cwd PATH` removes one registration. `uninstall cursor` with the matching scope removes only exact-owned entries and revokes capture authority. The existing application uninstall also removes owned Cursor entries. Malformed or edited ownership is preserved and reported unavailable.

The native settings file is `.cursor/hooks.json`, at the workspace or user scope. Installation preserves unrelated values and events, quotes every POSIX command word, and carries only an installation ID and private descriptor path. It does not write capability tokens or consent flags into Cursor settings. Installing twice preserves identical settings bytes. Doctor reports configuration and transport separately and does not claim capture verification or execute the vendor.

Only observation events are installed: sessionStart, sessionEnd, beforeSubmitPrompt, postToolUse, postToolUseFailure, afterAgentResponse and stop. Permission hooks are omitted because Cursor documents that empty/invalid permission responses can block an action. Capture callbacks always produce empty stdout and exit zero on unavailable, malformed, stale or failed export. They never issue policy decisions, start a daemon, load a database or read a hook-supplied transcript path. Cursor can import Claude hook settings; recognizable Cursor payloads sent to those older callbacks are ignored so the native adapter owns the observation once.

Conversation, generation and tool identifiers provide retransmission deduplication. Responses without a generation identity remain unlinked assertions. A generation is not a guaranteed unique identity for every assistant fragment, so output coverage stays partial. Hooks do not establish provider execution, token usage, wall-clock span boundaries or a finished runtime. Runs and evaluation completion retain those unknowns. Actual tool/model text is retained only under full consent with the mandatory redaction floor; user email, attachments, transcript paths and reasoning blocks are not captured.

Protocol references: [Cursor Hooks](https://cursor.com/docs/hooks) and [Third Party Hooks](https://cursor.com/docs/reference/third-party-hooks), checked October 18, 2026. This implementation deliberately observes completion rather than controlling tool execution.
