# Trusted browser verification

Run Phantom can open an isolated local browser, send native browser input, and check a declared DOM, network, or console outcome. The optional browser worker is separate from paired SDK sessions. A browser input result describes dispatch; only a declared outcome creates a verification report. Focus changes are labeled `none` for input, and uncertain dispatch is never retried.

The local host must explicitly configure an existing Playwright 1.62.1 module, its matching driver, and installed browser resources. This feature adds no runtime package dependency, installs nothing, and accepts no module, executable, profile, arguments, CDP endpoint, or JavaScript from API/MCP callers.

```sh
RUNPHANTOM_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs \
RUNPHANTOM_BROWSER_CACHE=/absolute/path/to/matching/browser-cache \
RUNPHANTOM_BROWSER_ARTIFACTS=/absolute/path/to/private/browser-artifacts \
bun src/index.ts serve
```

The module entry must sit beside the matching package manifest. Configuration status means the runtime was found; each engine is qualified when it launches. Missing/incompatible runtime, driver, or engine returns unavailable. There is no automatic source fallback. Chromium, Firefox, and WebKit use fresh owned contexts; native single-select input is deliberately limited to one unique ASCII option label with no ambiguous prefix. Unsupported controls refuse before input. Private/file inputs, ambiguous targets, hidden/disabled controls, frames, locator chaining, and stored SDK references are refused.

Owned capture listeners and policy are installed before navigation. Only the exact target origin and an optional host-supplied asset-origin list (`RUNPHANTOM_BROWSER_ASSET_ORIGINS`, comma-separated exact origins, maximum 16) may be requested. Asset origins cannot become navigation destinations. The daemon control origin is forbidden. Owned service workers are blocked; downloads, popups, file choosers, and new WebSockets disclose loss and are denied. Parallel requests have distinct identities and finish only after the body completes.

The worker-created initial navigation requires the exact native request and response, one main-document commit, the current operation identity and cancellation/generation fences. A fresh owned page also receives a qualified page-world document condition before page scripts: captured native intrinsics observe original-root replacement and require genuine DOMContentLoaded. Removing and restoring the same root retains loss. This finite condition supplements the independent native receipt under its existing HTTP deadline; it does not establish OS or browser-native authority. Attached pages receive no document mutation or init script. This initial qualification does not complete the broader F28/F47 engine and attached-page requirements.

The initial `bounded-http-v1` profile mediates admitted HTTP(S) requests through bounded built-in HTTP clients and fulfills the original body only after acquisition completes. Every status 300–399 is unavailable before browser fulfillment, including redirects to the same origin and responses without Location. There is no retry, route continuation, preflight emulation, or automatic redirect following. Compressed responses, downloads, incremental streaming, custom authentication, and URL credentials are unavailable. HTTPS retains default certificate verification. HTTP2/HTTP3, browser TLS fingerprints, proxy/client certificates, host-specific CA configuration, and broad login compatibility remain unqualified. A refused response cannot undo the initial server-side action.

Cookie-free target-origin requests are the common initial profile across all three engines. Owned Chromium and Firefox additionally support only the qualified controlled HttpOnly/SameSite=Strict subset: exact native host/path/secure matching and the actual intercepted Cookie header. The worker never builds a Cookie header from a jar. One controlled Set-Cookie field must have HttpOnly, SameSite=Strict and Path=/; unknown, domain, expiry, folded or multiple fields refuse. WebKit and attached cookie-bearing requests and Set-Cookie responses are unavailable. Only the selected request URL's relevant native cookies are queried, transiently, under the current authority fence.

Approved foreign assets support cookie-free GET/HEAD only in the qualified fresh owned Chromium 151.0.7922.34 context using Playwright 1.62.1. The worker checks every request's current origin, native context and cookie state; runtime configuration or engine name alone grants no capability. Foreign cookies, Set-Cookie, custom headers, unsafe Accept/Content-Type values, unsupported methods, and author-required preflights refuse before an outgoing request. Missing CORS permission is preserved; fulfillment cannot invent an access grant. Firefox, WebKit and attached foreign profiles are explicitly unavailable pending broader qualification. Their original foreign-asset positive requirements remain mandatory pending F47. Initial-profile evidence does not complete F28, F47 or global acceptance.

Headers, cookies and request/response bodies are processed transiently inside the fixed admission limits. They are excluded from the new diagnostic records, persisted reports and exports. New diagnostics contain only finite refusal codes or admitted status/byte counts. Existing bounded URL/network observations and privacy scrubbing remain in effect. These adapter bounds do not claim an OS or whole-process memory quota.

To attach to Chromium, the host may configure `RUNPHANTOM_BROWSER_CDP` with a loopback endpoint. The user must list and explicitly select one opaque page identity from the current listing; there is no default tab or URL first-match. Listing is capped at 32 pages. A closed page identity cannot select its replacement. Attached history begins at selection, and network coverage remains unavailable because preexisting browser state cannot be qualified. Existing and later attached WebSockets remain unqualified; the worker installs no unremovable WebSocket handler or context-wide route in the user's existing context. Closing an attached connection disconnects this worker and removes its selected-page HTTP listeners/routes; the user’s pages and browser remain alive.

In Verification, open a browser, choose an exact control, configure an expected outcome, and run the check. Input-only and screenshot operations never create a pass. An observed already-present DOM marker is a fact in the captured window, not proof that the action caused it. Missing coverage, lost evidence, unsupported state/signal/atomic transition checks, timeout, cancellation, or generation changes remain inconclusive. Registered application state, signals, semantic trees, and atomic transitions use the paired SDK workflow. Generation changes retain the UI draft but require explicit confirmation before more input.

Cancel/close synchronously fences authority and awaits bounded teardown of this provider’s own worker/connection. Clear awaits that teardown before clearing ordinary app data. If teardown cannot be confirmed, clear refuses and preserves saved data. Late results cannot restore authority or repopulate a cleared report store. Private browser artifacts survive app clear and require explicit deletion.

## Private artifacts and consent

Default screenshots mask inputs, editable areas, private markers, and known entered text. Masking is bounded; incomplete masking refuses safe capture. This scope is not a universal page-content sanitizer: other visible content may be sensitive. Raw screenshots require explicit API consent. Safe reports retain only bounded execution metadata and at most three artifact IDs, never image bytes or live browser authority.

Artifacts are stored in an owner-only directory with immutable private files and an atomic private manifest. Read access checks file kind, permissions, length, hash, and absence of symlinks. Corrupt/missing files are unavailable; report outcomes do not change. Raw downloads require explicit consent and return private attachment responses. API responses and MCP tools expose no host file paths. Restart restores saved reports/files, never live sessions or handles.

Video is default off. Owned recording requires explicit consent to unmasked private video, allows one recorder, stops after 60 seconds, and admits at most 32 MiB after awaited context close/flush. The spool watcher is a soft size threshold, not an OS hard disk quota; temporary overshoot is possible. Oversized final files are refused/deleted. Video cannot establish an outcome, is never automatically exported, and attached video is unavailable.

| Bound | Limit |
| --- | --- |
| Live provider connections / operations | 2 connections, 1 operation per connection |
| Input / startup / close | 5 s input, 15 s startup, 10 s bounded teardown |
| Worker frame / outstanding requests | 128 KiB frame, 2 outstanding replies |
| Pending observed requests | 1,000 per connection; loss is explicit |
| Admitted HTTP operations | 4 concurrent, no queue; all routed attempts charged, admission closes on attempt 1,000 |
| HTTP operation deadline | 5 s total using a monotonic clock, including native headers/cookies, response and fulfillment |
| HTTP raw headers | 100 fields, 16 KiB summed UTF-8 name/value bytes before folding; native parser may refuse sooner |
| HTTP request / response bodies | 64 KiB request, 2 MiB response, 16 MiB cumulative received bytes per connection |
| HTTP diagnostic retention | 100 finite records and fixed finite-code counters |
| Known input privacy records | 100 values, 64 KiB total; refuse further input when full |
| Viewport screenshot | 1920 × 1080 maximum, 8 MiB admitted |
| Retained artifacts | 100 records, 256 MiB admitted; capacity refuses until explicit deletion |
| Saved execution context | 1 KiB, at most 3 inert artifact IDs, inside the original whole 64 KiB context budget |

Local qualification uses controlled browser fixtures with blank provider keys. Those fixtures prove browser input/capture boundaries, not a paid provider or external business integration. Source execution, source-runtime UI screenshots, copied-native execution, and untested platform/engine cells must be labeled separately in qualification evidence. Run Phantom is maintained by Divyam Talwar.
