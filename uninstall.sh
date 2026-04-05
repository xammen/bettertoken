#!/usr/bin/env bash
# BetterToken Patcher - Mac/Linux uninstaller
# Usage: curl -fsSL https://raw.githubusercontent.com/xammen/bettertoken/main/uninstall.sh | bash

set -e

REPO="https://raw.githubusercontent.com/xammen/bettertoken/main"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo ""
echo "  BetterToken Uninstaller"
echo "  ───────────────────────"
echo ""

if ! command -v bun &>/dev/null; then
  echo "  Bun is required but not installed."
  exit 1
fi

echo "  Downloading patcher..."
curl -fsSL "$REPO/scripts/patch.ts" -o "$TMPDIR/patch.ts"

echo "  Removing patch..."
echo ""
bun run "$TMPDIR/patch.ts" --undo
