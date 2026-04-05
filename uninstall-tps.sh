#!/usr/bin/env bash
# Uninstall opencode-tps-meter (cross-platform replacement for their buggy uninstall.sh)
# Usage: curl -fsSL https://raw.githubusercontent.com/xammen/bettertoken/main/uninstall-tps.sh | bash

set -e

REPO="https://raw.githubusercontent.com/xammen/bettertoken/main"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

if ! command -v bun &>/dev/null; then
  echo "  Bun is required but not installed."
  exit 1
fi

curl -fsSL "$REPO/scripts/patch.ts" -o "$TMPDIR/patch.ts"
bun run "$TMPDIR/patch.ts" --uninstall-tps
