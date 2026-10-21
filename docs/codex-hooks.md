# Codex session observations

Run Phantom can capture a local project's Codex session through native lifecycle
hooks. Install explicitly from that project:

```sh
runphantom hooks install codex --local --full --consent-full
runphantom hooks doctor codex --local
runphantom hooks uninstall codex --local
```

Use `--cwd PATH` for a different project and `--port PORT` when the daemon uses
a nondefault port. Start the local daemon separately. Installation changes only
owned entries in that project's `.codex/hooks.json`; it preserves unrelated
handlers and does not edit `config.toml`. Review and trust the new hooks through
Codex's `/hooks` interface. Installation and doctor do not certify capture.

This implementation requires the private POSIX filesystem profile: the local
Run Phantom registration, Codex sessions directory, descendant directories and
rollout files must be owned by the current user, private and unlinked. Windows
private-file qualification is unavailable. Global capture is not enabled.

The decoder is pinned to Codex CLI 0.163.0 JSONL rollouts. Codex documents the
transcript format as unstable; other versions, forked/subagent identities,
incomplete tails, conflicting tool identities, invalid usage, oversized sources
and unavailable private files are refused. The 2 MiB source limit is a refusal
bound, not a claim of complete capture for longer sessions. Callbacks have a
1.5-second lifetime, emit no stdout and return success during export failure.

Each session has one deterministic root; individual turns and tools remain
distinct. Only the root carries the latest cumulative provider-reported usage.
Cached input is already included in input tokens and reasoning output is already
included in output tokens. Neither category nor child spans add those totals
again. Missing usage remains unknown. A turn `Stop` does not finish a session,
and even `SessionEnd` does not prove that captured output is complete.

The Runs conversation displays producer-reported, partial, runtime-unverified
observations and does not offer replay from those observations. Full capture
retains prompt/tool/assistant bodies locally; enable it only for projects where
you intend to retain that content. This integration uses ordinary local OTLP
ingestion, with its existing local access controls. It does not grant execution
authority or a separate durable publication capability.

The implementation is tested with synthetic vendor-format records and actual
installed callback commands against an isolated daemon. A genuine installed
Codex producer session, paid model use, other rollout versions, native Windows
and a combined deployment remain separate qualification gates.

The supported hook and trust behavior is documented in the
[official Codex hooks reference](https://developers.openai.com/codex/hooks).
The pinned token-accounting shape is defined by
[the 0.163.0 protocol source](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/protocol.rs).
