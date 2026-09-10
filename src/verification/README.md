# Application verification

Run Phantom can inspect an agent's execution and verify what happened in the application it worked on. The Verification workspace connects to a local development page, records runtime evidence, checks declared outcomes, and saves results alongside an optional agent run.

## Connect an application

1. Start Run Phantom using `bun run dev` or your locally built binary.
2. Open **Verification** in the sidebar. Enter the application's exact local origin, such as `http://localhost:3000`. Optionally link an existing run.
3. Create the session and copy its setup snippet into the application's development entry point. The snippet imports the SDK from the Run Phantom daemon and supplies the session's temporary connection credential.
4. Open the application. The workspace shows when its SDK connects.

The SDK must run only during local development. Remove the setup code from production builds. Pairing is scoped to the exact application origin; different localhost ports are different origins. Application connection credentials do not authorize Run Phantom's control APIs. Credentials are returned when a session is created and are not included in session lists or saved reports.

The generated SDK is an ES module at `http://localhost:5947/verification/sdk.js` (use your daemon's actual address/port):

```js
import { connect } from 'http://localhost:5947/verification/sdk.js';

const verification = connect({
  url: 'http://localhost:5947',
  sessionId: 'SESSION_FROM_RUN_PHANTOM',
  token: 'TEMPORARY_TOKEN_FROM_RUN_PHANTOM',
});

const unregisterCart = verification.registerStore('cart', () => cartStore.getState());
// Emit this only after your application has actually saved the order.
verification.signal('order:saved', { orderId: 'example-order' });

// On development teardown:
unregisterCart();
verification.disconnect();
```

Keep the session credential out of source control and production bundles. It expires with the local session; restarting the daemon requires pairing again.

## Inspect, act and check

The SDK observes fetch/XHR metadata, console messages and route changes. It can read DOM snapshots, click a uniquely matching CSS selector, fill an editable input, read explicitly registered stores, and receive application signals. It does not capture request/response bodies or authorization headers. A fetch response records headers becoming available; use an application signal to verify completion of a streamed body.

An assertion checks a declared outcome: a network response with the expected status, an application signal, a store value, an element's presence, or the absence/presence of console errors. Combine checks when several consequences must hold.

Every result is one of:

- **Pass:** the required evidence supports the assertion in the observed interval.
- **Fail:** the observed behavior contradicts the assertion, or a completed observation did not produce the required outcome.
- **Inconclusive:** capture or coverage was incomplete, the application disconnected, or the available evidence could not decide the assertion.

Action checks use fresh observation boundaries. A network response retains the action identity from when its request started, so a previous action's delayed response cannot satisfy a newer one. Absence checks wait for a bounded quiet interval with continuous coverage. A pass describes that interval; it cannot establish that an error will never occur later.

## Save and replay flows

A flow stores a sequence of actions and expected outcomes. Replay runs against a connected application of the same origin and produces a durable report. Selectors must still identify the intended elements; Verification does not silently repair a selector that no longer matches.

Live input filling is supported, but **saved flows reject fill steps**. This prevents arbitrary input text from becoming a stored credential. Prepare the application's state before replay, or use application-specific test fixtures and clicks. Fill values are excluded from evidence and reports.

Reports and flows use Run Phantom's existing SQLite database. Pairings and raw recent-event buffers are temporary; reports survive daemon restarts. Each report retains the executed checks, their expected outcomes, observer coverage, observation boundaries and capture-loss facts. Sensitive or oversized expectations are visibly withheld; commands and entered values are not retained in that context. Deleting a flow or disconnecting its app leaves the report readable. A report linked to a run appears with a link back to that run. Deleting the linked run removes its reports, and clearing local data clears verification data as well.

## Use from an AI agent

The existing Run Phantom MCP server includes:

| Tool | Purpose |
| --- | --- |
| `app_session` | List, create or disconnect application sessions |
| `app_observe` | Read bounded recent evidence and coverage |
| `app_act` | Inspect the page, click, fill or read a store |
| `app_assert` | Check a predicate and save its result |
| `app_flow` | Save, list, replay or delete verification flows |

These complement the existing agent trace tools. `replay_run` still reruns an instrumented agent; `app_flow` replays an application's interaction flow.

## Scope and development

The supported environment is an instrumented local development page. CSS selector actions use synthetic browser events. Verification does not provide trusted native input, cross-origin iframe/shadow-tree traversal, automatic React fiber inspection, desktop shell capture, process snapshots, or a guarantee that all future application behavior is correct. Explicit registered stores and application signals provide additional evidence when DOM/network checks are insufficient.

The browser SDK is generated from the source in `browser/`; run `bun scripts/build-verification-sdk.ts` after changing it. `bun scripts/build-verification-sdk.ts --check` checks freshness without writing files and runs as part of the root build. The bundle is embedded so serving it does not require the source checkout at runtime.
