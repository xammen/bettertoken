# Uninstall opencode-tps-meter (cross-platform replacement for their buggy uninstall.sh)
# Usage: irm https://raw.githubusercontent.com/xammen/bettertoken/main/uninstall-tps.ps1 | iex

$ErrorActionPreference = "Stop"
$REPO = "https://raw.githubusercontent.com/xammen/bettertoken/main"
$CACHEBUST = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$TMPDIR = Join-Path $env:TEMP "bettertoken-tps-$(Get-Random)"

$bunPath = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunPath) {
    Write-Host "  Bun is required but not installed."
    exit 1
}

try {
    New-Item -ItemType Directory -Path $TMPDIR -Force | Out-Null
    Invoke-WebRequest -Uri "$REPO/scripts/patch.ts?cb=$CACHEBUST" -OutFile "$TMPDIR\patch.ts" -UseBasicParsing
    & bun run "$TMPDIR\patch.ts" --uninstall-tps
}
finally {
    Remove-Item -Path $TMPDIR -Recurse -Force -ErrorAction SilentlyContinue
}
