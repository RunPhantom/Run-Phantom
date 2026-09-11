---
name: instrument-agent
description: Set up local traces so the next useful agent run appears in Run Phantom. Use when the user wants to instrument an agent, wire local tracing, or make a real run show up in the Run Phantom UI.
---

You are helping connect a real agent entry point to Run Phantom so its next meaningful run becomes visible in the local debugger.

Run Phantom is the local viewer; it does not run the agent. The user's app runs the workflow, the tracing SDK or telemetry path captures model/tool boundaries and context, and Run Phantom renders the result.

Use a supported SDK or integration path. Do not invent endpoints or hand-wire unsupported ingestion behavior. If the repo's telemetry setup is too custom to instrument safely, stop with a clear handoff to the code owner or the SDK docs.

## Use Docs First

Before editing code, inspect the installed package README/types and any local telemetry setup that already exists. Prefer the exact current API over memory.

## Core Rules

- Give visible progress. Say what phase you are in, what you learned, and what you are about to edit.
- Instrument one real agent entry point first.
- Start with the smallest useful run, then enrich it.
- Respect existing telemetry ownership. If the repo already initializes OpenTelemetry or another tracer/provider, do not create a second global provider.
- Update the relevant SDK or integration before instrumentation edits if the repo is behind and the current package version is known to be unsafe or unsupported.
- Verification is required. Success means a useful run appears in Run Phantom, not just that dependencies installed.

## Mental Model

One useful run should show:

- the input that triggered the agent,
- the final output or error,
- the main model call,
- any real tool executions and results,
- enough properties to recognize the job, workspace, or conversation later.

Most integrations use one of three shapes:

- Interaction boundary: begin when one invocation starts, run the model/tool loop, then finish with output or error.
- SDK wrapper: wrap the agent/model SDK once and pass per-call metadata.
- Existing OpenTelemetry owner: attach to the current telemetry setup if the SDK supports that shape.

## Phase 0: Orient

Do a quick read-only pass:

- Find the target agent entry point: route, worker, CLI, queue job, MCP server, or agent class.
- Identify the runtime and agent SDK.
- Identify where tools actually execute.
- Identify package manager and env-file convention.
- Search for existing telemetry initialization.
- Check whether the local debugger is running at `http://127.0.0.1:5947/health`.

Ask only when the next edit would otherwise be a guess.

## Phase 1: Basic Run Visibility

Goal: prove the local trace path works with the smallest top-level instrumentation.

Make the smallest change:

- Point the app at the local debugger, usually with `RUNPHANTOM_LOCAL_DEBUGGER=http://127.0.0.1:5947/v1/`.
- Add minimal instrumentation to one real entry point: wrapper call metadata, or begin before the invocation and finish after final output or error.
- Run one representative invocation.
- Verify a run appears in Run Phantom with enough input/output to prove the right code path is connected.

If the app ran but no run appears, confirm the command exercised the instrumented entry point and that the environment variable reached the process.

If the debugger is not reachable, stop and say it is down. Do not claim success without a visible run.

## Phase 2: Enrichment

After the first run works:

- Add useful properties: tenant, org, workspace, request, job, session, conversation IDs, route, source, or surface.
- Ensure the model call is visible as a model span or obvious interaction summary.
- Ensure real tool executions are visible as tool spans or events.
- Preserve existing telemetry setup.
- Add streaming/live events only when the SDK supports them and they improve debugging.

## Verification

Use the strongest available check:

- UI: a visible run in Run Phantom.
- HTTP or local API only if the current project supports it.

Confirm the run is useful. If a run exists but the content is not useful, verification failed.

## Handoff

Verified:

> Wired. I ran the agent once and confirmed a useful run at `http://127.0.0.1:5947`.

Needs user run:

> Wired. Run Phantom is running at `http://127.0.0.1:5947`. Run `<command>` now; the next run should appear there. If it stays empty, we can debug further.
