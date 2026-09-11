#!/usr/bin/env bash
# scripts/fresh-install.sh — nuke every cached build artifact, then rebuild
# the runphantom binary from source via the local install pipeline.
#
# What this preserves:
#   - ~/.runphantom/runphantom.db*   (Run Phantom SQLite + WAL/SHM)
#
# What this destroys:
#   - app/dist, build/                    (Vite + Bun build outputs in repo)
#   - node_modules + app/node_modules     (forces a clean install)
#   - ~/.runphantom/ui-cache                (extracted UI tarball cache)
#   - ~/.runphantom/runphantom.pid   (stale PID can fool stop/start)
#   - /tmp/runphantom-local                 (sandbox install dir from install:local)
#   - any process bound to :5947 / :5948  (so the next start is unambiguous)
#
# After it finishes, you have a fresh binary at /tmp/runphantom-local/bin/runphantom
# and `runphantom setup` resolves to it (assuming /tmp/runphantom-local/bin is on PATH).

set -euo pipefail

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$REPO_ROOT"

C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
step() { printf '\n%s==>%s %s%s%s\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
note() { printf '%s   %s%s\n' "$C_DIM" "$*" "$C_RESET"; }

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [ -n "$pids" ]; then
    note "killing pid(s) $pids on :$port"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

step "stopping any process holding the runphantom ports"
kill_port 5947
kill_port 5948

step "wiping build artifacts (DB is preserved)"
rm -rf \
  "$REPO_ROOT/app/dist" \
  "$REPO_ROOT/app/node_modules" \
  "$REPO_ROOT/build" \
  "$REPO_ROOT/node_modules" \
  "$HOME/.runphantom/ui-cache" \
  "$HOME/.runphantom/runphantom.pid" \
  /tmp/runphantom-local
note "preserved: $HOME/.runphantom/runphantom.db*"

step "installing repo deps"
bun install

step "rebuilding + installing local runphantom binary"
bun run install:local

BIN="/tmp/runphantom-local/bin/runphantom"
if [ ! -x "$BIN" ]; then
  echo "fresh-install: expected $BIN to exist after install:local" >&2
  exit 1
fi

step "done"
note "binary:  $BIN"
note "version: $("$BIN" version)"
echo
echo "Next:"
case ":$PATH:" in
  *":/tmp/runphantom-local/bin:"*) echo "  runphantom setup" ;;
  *)                              echo "  $BIN setup" ;;
esac
