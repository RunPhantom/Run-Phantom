---
name: setup-agent-replay
description: Set up a local agent replay server so Run Phantom can replay a captured run against real code and tools.
---

You are working in the user's agent repository, not in Run Phantom itself.

Your job is to make the agent replayable from Run Phantom without the user manually starting a replay server.

## Target Contract

Run Phantom expects:

- `.runphantom/agents.yaml` committed in the agent repo.
- A replay server command in that yaml, plus `cwd` when the command must run from a subdirectory.
- A replay server with:
  - `GET /health`
  - `POST /replay`
- A local project registration via `runphantom replay register`.

Replay server ports must be in `61020-61044`.

The local debugger runs on `http://localhost:5947`.

If the local debugger is not reachable, start it and retry. Do not stop just because the local service was not already running.

## If `.runphantom/agents.yaml` Already Exists

Before changing anything, read `.runphantom/agents.yaml`.

If the user wants to use the existing replay setup:

1. Start or register the existing replay setup.
2. Verify `GET /health`.
3. Run `runphantom replay register`.
4. Stop. Do not scaffold a duplicate server.

## Setup Steps

### 1. Identify The Agent

Find:

- Event name used by tracing.
- Agent entry point to invoke.
- Runtime context the agent requires.
- Model defaults and obvious supported model overrides.
- Existing script and package manager conventions.

If the agent is not instrumented with Run Phantom tracing, stop and tell the user to instrument it first.

### 2. Infer Input And Prefill

Create the smallest input shape the agent actually needs to run.

Use `prefillFromTrace` only for fields that can be copied from a source run without inventing placeholders.

### 3. Pick A Port

Pick the first unused port in `61020-61044`.

Use that port as a constant in the generated replay server code.

Do not put the port in `.runphantom/agents.yaml`.

### 4. Generate The Replay Server

Create the smallest server that fits the project language and conventions.

Required `GET /health` response:

```json
{
  "ok": true,
  "eventName": "triage-agent-dev",
  "port": 61020,
  "cwd": "/absolute/path/to/project-or-subpackage",
  "command": "pnpm replay-server",
  "input": {
    "orgPublicId": "string",
    "orgId": "number"
  },
  "prefillFromTrace": {
    "orgPublicId": "properties.orgPublicId",
    "orgId": "properties.orgId"
  },
  "models": ["claude-sonnet-5", "gpt-5.6-luna"]
}
```

Required `POST /replay` request:

```typescript
interface ReplayRequest {
  replayRunId: string;
  sourceRunId?: string;
  messages: Message[];
  systemPrompt?: string;
  userMessage?: string;
  model?: string;
  context: Record<string, unknown>;
}
```

The server should keep the `POST /replay` request open until the replayed agent run finishes or fails.

Successful response:

```json
{ "replayId": "abc123", "status": "done" }
```

Failure response:

```json
{ "status": "error", "message": "Failed to create turn: ...", "stack": "..." }
```

Use a non-2xx HTTP response for request or agent failures when possible. A 200 response with `status: "error"` is also acceptable. Do not start the agent in a fire-and-forget async task that only logs errors after `POST /replay` has returned.

Replay should exercise the agent with as few side effects as possible. Before wiring the replay endpoint, inspect the agent's production entry point and extract the smallest reusable agent-running function you can.

Before invoking the agent, set:

```typescript
process.env.RUNPHANTOM_LOCAL_DEBUGGER = "http://localhost:5947/v1/";
```

Do not pass `replayRunId` through an environment variable.

Pass `request.context`, `request.messages`, `request.systemPrompt`, `request.userMessage`, and `request.model` into the agent in the way that matches the local codebase.

For trace stitching, pass `request.replayRunId` through the SDK metadata surface.

### 5. Standard Message Format

Run Phantom sends AI SDK-style JSON:

```typescript
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
```

For TypeScript AI SDK agents, this usually passes through directly.

For other SDKs or languages, generate the small adapter needed by that project.

### 6. Write `.runphantom/agents.yaml`

Example:

```yaml
triage-agent-dev:
  cwd: apps/dawn
  command: pnpm replay-server

  input:
    orgPublicId: string
    orgId: number

  prefillFromTrace:
    orgPublicId: properties.orgPublicId
    orgId: properties.orgId

  models:
    - claude-sonnet-5
    - gpt-5.6-luna
```

If adding another agent, preserve existing entries.

Use `cwd` for monorepos or nested apps when the replay command is only valid from a package directory.

### 7. Add Scripts

Add a small script that starts the replay server from the package's normal entry point.

### 8. Register The Project

Run:

```bash
runphantom replay register
```

The registration command should start each configured command from its `cwd`, wait for `/health`, confirm the agent is reachable, and store the last seen port.

### 9. Test Replay

Default to replaying a past trace. Use the current local run when available; otherwise ask the user to select a source run or provide a run id.

If the user agrees, run a test replay through Run Phantom. If the replay returns `missing_replay_agent` or says to run the setup skill, fix registration or startup and retry.

## Handoff

Verified:

> Replay setup is registered. Run Phantom can start the replay server automatically when Replay is clicked.

Needs user run:

> Replay setup is registered. Run `<command>` now; the next run should appear in Run Phantom.
