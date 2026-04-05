# BetterToken Patcher - Windows uninstaller
# Usage: irm https://raw.githubusercontent.com/xammen/bettertoken/main/uninstall.ps1 | iex

$ErrorActionPreference = "Stop"
$REPO = "https://raw.githubusercontent.com/xammen/bettertoken/main"
$TMPDIR = Join-Path $env:TEMP "bettertoken-unpatch-$(Get-Random)"

Write-Host ""
Write-Host "  BetterToken Uninstaller"
Write-Host "  -----------------------"
Write-Host ""

$bunPath = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunPath) {
    Write-Host "  Bun is required but not installed."
    exit 1
}

try {
    New-Item -ItemType Directory -Path $TMPDIR -Force | Out-Null

    Write-Host "  Downloading patcher..."
    Invoke-WebRequest -Uri "$REPO/scripts/patch.ts" -OutFile "$TMPDIR\patch.ts" -UseBasicParsing

    Write-Host "  Removing patch..."
    Write-Host ""
    & bun run "$TMPDIR\patch.ts" --undo
}
finally {
    Remove-Item -Path $TMPDIR -Recurse -Force -ErrorAction SilentlyContinue
}
