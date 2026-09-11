#!/usr/bin/env bash
# Run Phantom is source-first in this repository.
#
# There is no validated public release origin in this workspace, so this
# script intentionally does not advertise a curl|bash install flow.
# Use the local source checkout instead:
#
#   bun install
#   bun run dev
#
# If you are packaging a release outside this workspace, wire the external
# release origin there rather than editing this repository to invent one.

set -euo pipefail

if [ -f package.json ] && [ -d src ] && [ -d app ]; then
  echo "Run Phantom is checked out locally."
  echo "Use:"
  echo "  bun install"
  echo "  bun run dev"
  exit 0
fi

echo "Run Phantom does not publish an install origin from this repository."
echo "Clone the repository, then run: bun install && bun run dev"
exit 1
