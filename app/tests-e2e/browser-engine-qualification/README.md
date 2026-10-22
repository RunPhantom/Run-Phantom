# Explicit browser-engine qualification

These journeys use the real production UI, an isolated daemon/database and controlled local captured telemetry. They run only through `app/playwright.engines.config.ts`; `.journey.ts` files do not join the existing default `.spec.ts` roster. No product route, semantic assertion, dependency or default test configuration is changed.

Build the production UI from the exact candidate, then run with an explicitly selected existing resource cache and a new absolute evidence directory:

```sh
PLAYWRIGHT_BROWSERS_PATH=/absolute/private/browser-cache \
  bun --no-env-file scripts/qualification/browser-engines.ts \
  --output=/absolute/new-evidence-attempt
```

The runner acquires the global two-job/actual-checkout lease and the single canonical local browser lock exactly once. A busy browser lock returns BLOCKED instead of holding a heavy slot while waiting. All five tests must be collected and passed per available engine, with zero skips/retries. Missing engines, failed collection and absent observations never qualify. Each attempt is immutable; an existing output directory is refused.

Use `--binary=/absolute/current/copied/runphantom` to exercise that exact copied executable with private cwd/profile. The manifest labels source versus copied runtime and hashes the executable. This switch alone does not establish a source-free optional module/engine closure or fill installed-platform acceptance; retain those distinct closure and platform controls.

The five cases cover captured run/navigation/deep-link/reload/export identity; actual trusted input and final outcome/report/artifact; initial capture and reversed identical-request identity with concurrent/cancel fences; explicit opaque tab selection with existing user pages surviving detach; and normal paired-SDK flow save/replay with genuine marker removal changing the observed verdict while saved definitions remain unchanged. The selected-tab backend is Chromium CDP even when the user-facing UI engine is Firefox or WebKit; this is recorded explicitly. Native audits use the existing Chromium adapter. Unsupported Firefox/WebKit audit cells remain BLOCKED, not clean.

`inventory.json` records launcher/native hashes and installed provider identity; test runtime/teardown receipts add actual engine versions, native descendant hashes, backend PID/profile/cwd, preserved outputs and actual process reaping. Safe PNGs are distinct from trace/error artifacts, which remain private until inspected. No request mocks, paid providers, user browser profiles or synthetic trusted-event values supply product proof.

The full matrix intentionally returns nonzero while any mandatory cell is blocked: other native hosts, unsupported capabilities and the uncomposed recordings/new workspace UI/enabled dataset execution prerequisites remain unresolved. Passing base journeys do not establish full feature or release acceptance. Historical retries/failures remain separate attempts, never overwritten or counted as the current candidate.
