#!/usr/bin/env bash
# Build the host binary, serve it, and run the native smoke gate against it.
#
# app/tests-e2e/compiled-binary.spec.ts skips itself unless RUNPHANTOM_COMPILED_URL
# names a running compiled daemon. That guard is correct — the test cannot run
# against a source checkout — but it meant the packaged artifact went unexercised
# by default. It shipped with /api/agent/sessions and /api/claude/sessions
# returning 503, because `bun build --compile` had not embedded the worker that
# src/sessions-listing.ts spawns. Source mode returned 200 for both, so the whole
# root suite, both typecheckers and the browser suite stayed green over it.
#
# One command, so the artifact is actually testable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET="bun-darwin-arm64" ;;
  Darwin-x86_64) TARGET="bun-darwin-x64" ;;
  Linux-aarch64|Linux-arm64) TARGET="bun-linux-arm64" ;;
  Linux-x86_64) TARGET="bun-linux-x64" ;;
  *) echo "unsupported host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
BINARY="build/bun/runphantom-$TARGET"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "[test-compiled] building $TARGET"
  bun scripts/build-bun.ts
fi
[ -x "$BINARY" ] || { echo "[test-compiled] missing binary: $BINARY" >&2; exit 1; }

# realpath: the secret store refuses symlinked path components, and on macOS
# /tmp is a symlink to /private/tmp, so a raw mktemp path makes the daemon
# reject its own store.
STATE_DIR="$(cd "$(mktemp -d)" && pwd -P)"
PORT="${RUNPHANTOM_TEST_PORT:-5983}"
DAEMON_PID=""

cleanup() {
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

echo "[test-compiled] serving on :$PORT"
HOME="$STATE_DIR" \
RUNPHANTOM_PORT="$PORT" \
RUNPHANTOM_DB_PATH="$STATE_DIR/runphantom.db" \
RUNPHANTOM_SECRET_STORE_PATH="$STATE_DIR/secrets.json" \
  "./$BINARY" serve > "$STATE_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || {
  echo "[test-compiled] daemon never became healthy:" >&2
  tail -40 "$STATE_DIR/daemon.log" >&2
  exit 1
}

echo "[test-compiled] running native smoke gate"
cd app
RUNPHANTOM_COMPILED_URL="http://127.0.0.1:$PORT" \
RUNPHANTOM_SCREENSHOT_DIR="${RUNPHANTOM_SCREENSHOT_DIR:-$STATE_DIR/shots}" \
  bun x playwright test tests-e2e/compiled-binary.spec.ts
STATUS=$?
cd "$REPO_ROOT"

# A route can 503 while the page still renders, so the assertions alone do not
# prove the binary is whole. Fail on any runtime resolution error in the log.
if grep -q "ModuleNotFound" "$STATE_DIR/daemon.log"; then
  echo "[test-compiled] binary is missing an embedded module:" >&2
  grep -m3 "ModuleNotFound" "$STATE_DIR/daemon.log" >&2
  exit 1
fi

echo "[test-compiled] ok"
exit $STATUS
