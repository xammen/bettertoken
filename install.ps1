# BetterToken Patcher - Windows installer
# Usage: irm https://raw.githubusercontent.com/xammen/bettertoken/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$REPO = "https://raw.githubusercontent.com/xammen/bettertoken/main"
$CACHEBUST = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$TMPDIR = Join-Path $env:TEMP "bettertoken-patch-$(Get-Random)"

Write-Host ""
Write-Host "  BetterToken Installer"
Write-Host "  ---------------------"
Write-Host ""

# Check for bun
$bunPath = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunPath) {
    Write-Host "  Bun is required but not installed."
    Write-Host "  Install it: irm bun.sh/install.ps1 | iex"
    exit 1
}

try {
    New-Item -ItemType Directory -Path $TMPDIR -Force | Out-Null

    Write-Host "  Downloading patcher..."
    Invoke-WebRequest -Uri "$REPO/scripts/patch.ts?cb=$CACHEBUST" -OutFile "$TMPDIR\patch.ts" -UseBasicParsing

    Write-Host "  Running patcher..."
    Write-Host ""
    & bun run "$TMPDIR\patch.ts" @args
}
finally {
    Remove-Item -Path $TMPDIR -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  To install the BetterToken plugin, add to ~/.opencode/tui.jsonc:"
Write-Host ""
Write-Host '    { "plugin": ["opencode-bettertoken"] }'
Write-Host ""
Write-Host "  Then run: cd ~/.opencode; bun add opencode-bettertoken"
Write-Host ""
