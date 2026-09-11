#!/usr/bin/env bash
# Boots an explicitly supplied Run Phantom baseline against a temporary DB,
# seeds canonical fixtures, then re-opens that DB with the current source build.
# Catches the "drizzle migration drops a column" / "schema rename without
# migration" class — the kind of breakage that's only visible when an
# existing user upgrades.
#
# Set RUNPHANTOM_BASELINE_BINARY to an executable baseline before running.
# The script assumes bun, curl, jq, and sqlite3 are available.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-5990}"
TMP="$(mktemp -d)"
DB="$TMP/upgrade.db"
DAEMON_LOG="$HOME/.runphantom/runphantom.log"
export RUNPHANTOM_DB_PATH="$DB"
export PORT
export RUNPHANTOM_PORT="$PORT"

log_size() { [ -f "$DAEMON_LOG" ] && wc -c < "$DAEMON_LOG" | tr -d ' ' || echo 0; }
log_since() {
  local before="$1"
  local now; now="$(log_size)"
  [ "$now" -le "$before" ] && return 0
  tail -c "$((now - before))" "$DAEMON_LOG"
}

# Poll /health until the daemon responds or the deadline elapses. Stable
# binaries' built-in `runphantom start` boot wait is short enough that a
# cold first-boot (sqlite migration replay + bun imports) can race past
# it on ubuntu-latest under load — poll independently so the smoke test
# doesn't depend on the binary's exit code.
wait_for_health() {
  local port="$1"
  local timeout_s="${2:-60}"
  local deadline=$((SECONDS + timeout_s))
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -fsS "http://localhost:$port/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

cleanup() {
  set +e
  [ -n "${OLD_BIN:-}" ] && [ -x "$OLD_BIN" ] && "$OLD_BIN" stop >/dev/null 2>&1
  [ -n "${NEW_BIN:-}" ] && [ -x "$NEW_BIN" ] && "$NEW_BIN" stop >/dev/null 2>&1
}
trap cleanup EXIT

echo "── 1/8 validate the explicit Run Phantom baseline"
OLD_BIN="${RUNPHANTOM_BASELINE_BINARY:-}"
[ -n "$OLD_BIN" ] || { echo "::error::set RUNPHANTOM_BASELINE_BINARY to an executable baseline"; exit 2; }
[ -x "$OLD_BIN" ] || { echo "::error::baseline is not executable: $OLD_BIN"; exit 2; }
OLD_VER="$("$OLD_BIN" --version 2>&1 | head -1)"
echo "   stable = $OLD_VER"

echo "── 2/8 boot stable against $DB on :$PORT"
# The daemon is detached and `child.unref`'d — it keeps coming up even when
# `runphantom start` reports a boot-wait timeout. `wait_for_health` is the
# source of truth for readiness.
"$OLD_BIN" start || true
wait_for_health "$PORT" 60 || {
  echo "::error::stable daemon did not respond on :$PORT within 60s"
  [ -f "$DAEMON_LOG" ] && tail -200 "$DAEMON_LOG"
  exit 1
}

echo "── 3/8 seed fixtures via OTLP"
RUNPHANTOM_URL="http://localhost:$PORT" bun "$REPO_ROOT/scripts/seed-traces.ts"

# Pinned trace ID for fixture 1 (`fixtureSuccessfulEdit`, salt=0). Used below
# to assert per-row data survives migration, not just aggregate row count —
# a migration that drops `event_name` or truncates `input_payload` would still
# pass a count check but break the UI.
FIXTURE_RUN_ID="00000000000000000000000000000001"

echo "── 4/8 snapshot run count + fixture outline under stable"
OLD_RUNS="$(curl -fsS "http://localhost:$PORT/api/runs?limit=5000" | jq 'length')"
echo "   $OLD_RUNS runs persisted"
[ "$OLD_RUNS" -ge 3 ] || { echo "::error::expected ≥3 seeded runs, got $OLD_RUNS"; exit 1; }
OLD_OUTLINE="$(curl -fsS "http://localhost:$PORT/api/runs/$FIXTURE_RUN_ID/outline?payload_preview_chars=400")"
OLD_EVENT_NAME="$(printf '%s' "$OLD_OUTLINE" | jq -r '.run.event_name // empty')"
OLD_SPAN_COUNT="$(printf '%s' "$OLD_OUTLINE" | jq '.spans | length')"
[ -n "$OLD_EVENT_NAME" ] || { echo "::error::stable did not return event_name for $FIXTURE_RUN_ID"; exit 1; }
[ "$OLD_SPAN_COUNT" -gt 0 ] || { echo "::error::stable returned 0 spans for $FIXTURE_RUN_ID"; exit 1; }
echo "   fixture run: event_name=$OLD_EVENT_NAME spans=$OLD_SPAN_COUNT"
"$OLD_BIN" stop

# Direct DB introspection under stable: the API returns previews of
# payload columns and hides the migrations journal. Open the sqlite
# file directly to capture invariants the API can't:
#  - `__drizzle_migrations` row count: proves how many migrations have
#    been applied, so we can detect a journal that gets *wiped* during
#    upgrade (catastrophic — drizzle would re-run all migrations against
#    an already-migrated schema and corrupt data).
#  - Raw `input_payload` for fixture 1's root span: API truncates this
#    to preview_chars. A migration that silently shortens the column
#    type or rewrites it would pass the outline check but break the
#    actual payload pane. Snapshot the prompt text from the raw column.
#  - Schema table set: catches a migration that drops a table entirely.
# sqlite3 CLI is preinstalled on ubuntu-latest GHA runners.
echo "   reading raw DB state via sqlite3..."
OLD_MIGRATION_COUNT="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM __drizzle_migrations')"
[ "$OLD_MIGRATION_COUNT" -gt 0 ] || { echo "::error::__drizzle_migrations empty under stable"; exit 1; }
OLD_INPUT_PAYLOAD="$(sqlite3 "$DB" "SELECT input_payload FROM spans WHERE run_id='$FIXTURE_RUN_ID' AND parent_span_id IS NULL")"
[ -n "$OLD_INPUT_PAYLOAD" ] || { echo "::error::stable: fixture root span has empty input_payload"; exit 1; }
OLD_TABLES="$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" | tr '\n' ',')"
echo "   migrations=$OLD_MIGRATION_COUNT  payload_bytes=${#OLD_INPUT_PAYLOAD}  tables=$OLD_TABLES"

echo "── 5/8 build PR's binary"
( cd "$REPO_ROOT" && bun scripts/build-bun.ts >/dev/null )
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"; [ "$HOST_ARCH" = "x86_64" ] && HOST_ARCH="x64"; [ "$HOST_ARCH" = "aarch64" ] && HOST_ARCH="arm64"
NEW_BIN="$REPO_ROOT/build/bun/runphantom-bun-${HOST_OS}-${HOST_ARCH}"
[ -x "$NEW_BIN" ] || { echo "::error::build did not produce $NEW_BIN"; exit 1; }
NEW_VER="$("$NEW_BIN" --version 2>&1 | head -1)"
echo "   PR     = $NEW_VER"
if [ "$OLD_VER" = "$NEW_VER" ]; then
  echo "::warning::stable and PR report the same version — upgrade-path test only validates re-open of an unchanged schema"
fi

echo "── 6/8 boot PR binary against the SAME db"
"$NEW_BIN" start || true
wait_for_health "$PORT" 60 || {
  echo "::error::PR daemon did not respond on :$PORT within 60s"
  [ -f "$DAEMON_LOG" ] && tail -200 "$DAEMON_LOG"
  exit 1
}

echo "── 7/8 verify migration preserved data"
NEW_RUNS="$(curl -fsS "http://localhost:$PORT/api/runs?limit=5000" | jq 'length')"
echo "   $NEW_RUNS runs survive migration"
[ "$NEW_RUNS" -ge "$OLD_RUNS" ] || {
  echo "::error::data loss after upgrade: $OLD_RUNS → $NEW_RUNS"
  exit 1
}
# Per-row check: fetch the same fixture run and assert its event_name +
# span count survive. Aggregate count check alone misses migrations that
# drop columns, truncate payloads, or rename event_name.
NEW_OUTLINE="$(curl -fsS "http://localhost:$PORT/api/runs/$FIXTURE_RUN_ID/outline?payload_preview_chars=400")"
NEW_EVENT_NAME="$(printf '%s' "$NEW_OUTLINE" | jq -r '.run.event_name // empty')"
NEW_SPAN_COUNT="$(printf '%s' "$NEW_OUTLINE" | jq '.spans | length')"
if [ "$NEW_EVENT_NAME" != "$OLD_EVENT_NAME" ]; then
  echo "::error::fixture run.event_name changed across upgrade: $OLD_EVENT_NAME → $NEW_EVENT_NAME"
  exit 1
fi
if [ "$NEW_SPAN_COUNT" != "$OLD_SPAN_COUNT" ]; then
  echo "::error::fixture span count changed across upgrade: $OLD_SPAN_COUNT → $NEW_SPAN_COUNT"
  exit 1
fi
echo "   fixture run intact: event_name=$NEW_EVENT_NAME spans=$NEW_SPAN_COUNT"

# Direct DB introspection under PR binary: verify the invariants we
# snapshotted before the upgrade. These catch failure modes the API
# can't see (preview comes from a separate column, runs list doesn't
# expose the migrations journal).
echo "   reading raw DB state via sqlite3..."
NEW_TABLES="$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" | tr '\n' ',')"
NEW_MIGRATION_COUNT="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM __drizzle_migrations')"
NEW_INPUT_PAYLOAD="$(sqlite3 "$DB" "SELECT input_payload FROM spans WHERE run_id='$FIXTURE_RUN_ID' AND parent_span_id IS NULL")"

# All tables that existed under stable must still exist. New tables are
# fine (a forward migration that adds a table is expected). A dropped
# table is the regression we're guarding against.
old_ifs="$IFS"; IFS=','
for t in $OLD_TABLES; do
  [ -z "$t" ] && continue
  case ",$NEW_TABLES," in *",$t,"*) ;; *)
    echo "::error::table '$t' present under stable but missing after upgrade"
    exit 1 ;;
  esac
done
IFS="$old_ifs"

# Drizzle is append-only: the journal under PR must include every row
# stable had. If it doesn't, drizzle wiped the journal and will re-run
# every migration on subsequent boots — a corruption vector.
if [ "$NEW_MIGRATION_COUNT" -lt "$OLD_MIGRATION_COUNT" ]; then
  echo "::error::__drizzle_migrations shrank across upgrade: $OLD_MIGRATION_COUNT → $NEW_MIGRATION_COUNT (journal wiped — drizzle will re-run migrations)"
  exit 1
fi
# Also useful signal: if the row count is unchanged AND the stable and
# PR binaries report different versions, the migration was a no-op.
# Not a failure (most PRs don't change schema) — just an info line.
if [ "$NEW_MIGRATION_COUNT" = "$OLD_MIGRATION_COUNT" ]; then
  echo "   migration journal unchanged (no schema change in this PR)"
else
  echo "   migration journal advanced: $OLD_MIGRATION_COUNT → $NEW_MIGRATION_COUNT"
fi

# The raw payload column: the API only returns a preview, so a
# migration that truncates the underlying column or rewrites it would
# pass the outline check. The exact byte-for-byte match is the
# strongest guarantee.
if [ "$NEW_INPUT_PAYLOAD" != "$OLD_INPUT_PAYLOAD" ]; then
  echo "::error::raw spans.input_payload changed across upgrade for fixture root span"
  echo "   stable: ${OLD_INPUT_PAYLOAD:0:200}"
  echo "   PR    : ${NEW_INPUT_PAYLOAD:0:200}"
  exit 1
fi
echo "   raw payload preserved: ${#NEW_INPUT_PAYLOAD} bytes match"

echo "── 8/8 seed fresh traces under PR binary, verify writes accepted + no daemon errors"
LOG_BEFORE_WRITE="$(log_size)"
# Salt the trace IDs so the second seed produces distinct rows instead of
# upserting the originals — the strict-greater check below depends on it.
RUNPHANTOM_URL="http://localhost:$PORT" RUNPHANTOM_SEED_SALT=1000 \
  bun "$REPO_ROOT/scripts/seed-traces.ts"
# Daemon flushes spans + partial events on a short interval; give it room.
sleep 2
FINAL_RUNS="$(curl -fsS "http://localhost:$PORT/api/runs?limit=5000" | jq 'length')"
echo "   $FINAL_RUNS runs after fresh seed"
[ "$FINAL_RUNS" -gt "$NEW_RUNS" ] || {
  echo "::error::PR binary did not accept new writes: $NEW_RUNS → $FINAL_RUNS"
  exit 1
}
WRITE_LOGS="$(log_since "$LOG_BEFORE_WRITE")"
# Run Phantom daemon uses `console.error("[runphantom] Error <verb>:", err)` for
# server-side ingest/chat/replay failures (src/server.ts). Any of those during
# the fresh seed means the upgrade broke writes.
if printf '%s' "$WRITE_LOGS" | grep -qiE '\[runphantom\].*(error|failed|exception|panic)'; then
  echo "::error::PR binary daemon logged errors during fresh writes:"
  printf '%s' "$WRITE_LOGS" | grep -iE '\[runphantom\].*(error|failed|exception|panic)' | head -20
  exit 1
fi
echo "✓ upgrade-path smoke test passed: $OLD_VER → $NEW_VER ($OLD_RUNS → $NEW_RUNS → $FINAL_RUNS runs)"
