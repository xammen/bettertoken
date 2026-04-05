#!/usr/bin/env bash
# BetterToken Patcher - Mac/Linux installer
# Usage: curl -fsSL https://raw.githubusercontent.com/xammen/bettertoken/main/install.sh | bash

set -e

REPO="https://raw.githubusercontent.com/xammen/bettertoken/main"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo ""
echo "  BetterToken Installer"
echo "  ─────────────────────"
echo ""

# Check for bun
if ! command -v bun &>/dev/null; then
  echo "  Bun is required but not installed."
  echo "  Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo "  Downloading patcher..."
curl -fsSL "$REPO/scripts/patch.ts" -o "$TMPDIR/patch.ts"

echo "  Running patcher..."
echo ""
bun run "$TMPDIR/patch.ts" "$@"

echo ""
echo "  To install the BetterToken plugin, add to ~/.opencode/tui.jsonc:"
echo ""
echo '    { "plugin": ["opencode-bettertoken"] }'
echo ""
echo "  Then run: cd ~/.opencode && bun add opencode-bettertoken"
echo ""
