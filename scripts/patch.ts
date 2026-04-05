#!/usr/bin/env bun
/**
 * BetterToken Patcher
 *
 * Clones OpenCode source, applies a .patch file via git apply, runs bun install,
 * and creates launcher wrappers. Cross-platform (Windows/Mac/Linux).
 *
 * Usage:
 *   bun run patch.ts                 # Install patched OpenCode
 *   bun run patch.ts --undo          # Restore stock OpenCode
 *   bun run patch.ts --uninstall-tps # Remove TPS meter installation
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execSync } from "node:child_process"
import { SUPPORTED_VERSIONS, LATEST_SUPPORTED, isSupported, resolve, printSupported } from "./manifest"

const UPSTREAM_REPO = "https://github.com/anomalyco/opencode.git"
const PATCHES_URL = "https://raw.githubusercontent.com/xammen/bettertoken/main/patches"
const UNDO = process.argv.includes("--undo")
const UNINSTALL_TPS = process.argv.includes("--uninstall-tps")

const HOME = os.homedir()
const IS_WIN = process.platform === "win32"

const INSTALL_ROOT = IS_WIN
  ? path.join(HOME, "AppData", "Local", "bettertoken")
  : path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "bettertoken")

const RELEASES_DIR = path.join(INSTALL_ROOT, "releases")
const OPENCODE_BIN = path.join(HOME, ".opencode", "bin")

// ── Helpers ───────────────────────────────────────────────────────────

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch {
    return ""
  }
}

function runLoud(cmd: string, cwd?: string) {
  execSync(cmd, { cwd, stdio: "inherit" })
}

function need(cmd: string, hint: string) {
  const found = IS_WIN ? run(`where ${cmd}`) : run(`command -v ${cmd}`)
  if (!found) {
    console.error(`  Missing: ${cmd}`)
    console.error(`  ${hint}`)
    process.exit(1)
  }
}

function detectVersion(): string {
  for (const loc of [
    path.join(OPENCODE_BIN, IS_WIN ? "opencode-stock.exe" : "opencode-stock"),
    path.join(OPENCODE_BIN, IS_WIN ? "opencode.exe" : "opencode"),
  ]) {
    if (!fs.existsSync(loc)) continue
    const ver = run(`"${loc}" --version`)
    if (ver && /^\d+\.\d+\.\d+/.test(ver)) return ver.split(" ")[0]
  }
  const ver = run("opencode --version")
  if (ver && /^\d+\.\d+\.\d+/.test(ver)) return ver.split(" ")[0]
  return ""
}

function bunBin(): string {
  return IS_WIN ? run("where bun").split("\n")[0].trim() : run("command -v bun").trim()
}

// ── Wrappers ──────────────────────────────────────────────────────────

function createWrappers(sourceDir: string, bun: string) {
  if (!fs.existsSync(OPENCODE_BIN)) fs.mkdirSync(OPENCODE_BIN, { recursive: true })

  // Backup stock binary
  const stockExe = path.join(OPENCODE_BIN, IS_WIN ? "opencode.exe" : "opencode")
  const stockBackup = path.join(OPENCODE_BIN, IS_WIN ? "opencode-stock.exe" : "opencode-stock")
  if (fs.existsSync(stockExe) && !fs.existsSync(stockBackup)) {
    fs.copyFileSync(stockExe, stockBackup)
    console.log(`  Backed up: ${stockBackup}`)
  }

  if (IS_WIN) {
    fs.writeFileSync(path.join(OPENCODE_BIN, "opencode.ps1"),
`$env:OPENCODE_LAUNCH_CWD = (Get-Location).Path
$SourceDir = "${sourceDir}"
if (-not (Test-Path $SourceDir)) {
    Write-Warning "BetterToken source not found, falling back to stock..."
    & "$PSScriptRoot\\opencode-stock.exe" @args
    return
}
& "${bun}" --cwd $SourceDir --conditions=browser ./src/index.ts @args
`)
    fs.writeFileSync(path.join(OPENCODE_BIN, "opencode.cmd"),
`@echo off
set "OPENCODE_LAUNCH_CWD=%CD%"
set "SOURCE_DIR=${sourceDir}"
if not exist "%SOURCE_DIR%" (
    echo Falling back to stock opencode... 1>&2
    "%~dp0opencode-stock.exe" %*
    exit /b %ERRORLEVEL%
)
"${bun}" --cwd "%SOURCE_DIR%" --conditions=browser ./src/index.ts %*
`)
  } else {
    const wrapper = path.join(OPENCODE_BIN, "opencode")
    fs.writeFileSync(wrapper,
`#!/bin/sh
export OPENCODE_LAUNCH_CWD="$(pwd)"
SOURCE_DIR="${sourceDir}"
if [ ! -d "$SOURCE_DIR" ]; then
  exec "${stockBackup}" "$@"
fi
exec "${bun}" --cwd "$SOURCE_DIR" --conditions=browser ./src/index.ts "$@"
`)
    fs.chmodSync(wrapper, 0o755)
  }
  console.log("  Wrappers created.")
}

function restoreStock() {
  console.log("  Restoring stock OpenCode...")
  if (IS_WIN) {
    const stockBackup = path.join(OPENCODE_BIN, "opencode-stock.exe")
    if (fs.existsSync(stockBackup)) {
      fs.copyFileSync(stockBackup, path.join(OPENCODE_BIN, "opencode.exe"))
      fs.unlinkSync(stockBackup)
    }
    fs.writeFileSync(path.join(OPENCODE_BIN, "opencode.ps1"), `& "$PSScriptRoot\\opencode.exe" @args\n`)
    fs.writeFileSync(path.join(OPENCODE_BIN, "opencode.cmd"), `@echo off\n"%~dp0opencode.exe" %*\n`)
  } else {
    const stock = path.join(OPENCODE_BIN, "opencode-stock")
    const wrapper = path.join(OPENCODE_BIN, "opencode")
    if (fs.existsSync(stock)) fs.renameSync(stock, wrapper)
  }
  if (fs.existsSync(INSTALL_ROOT)) {
    try { fs.rmSync(INSTALL_ROOT, { recursive: true, force: true }) } catch {}
  }
  console.log("  Stock OpenCode restored. Restart to apply.")
}

// ── Uninstall TPS Meter ───────────────────────────────────────────────

function uninstallTpsMeter() {
  console.log("  Uninstalling opencode-tps-meter...")
  const tpsRoot = IS_WIN
    ? path.join(HOME, "AppData", "Local", "opencode-tps-meter")
    : path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "opencode-tps-meter")

  if (!fs.existsSync(tpsRoot)) {
    console.log("  Not installed."); process.exit(0)
  }

  // Restore wrappers
  for (const ext of IS_WIN ? [".ps1", ".cmd"] : [""]) {
    const wrapper = path.join(OPENCODE_BIN, `opencode${ext}`)
    try {
      if (!fs.existsSync(wrapper)) continue
      const content = fs.readFileSync(wrapper, "utf-8")
      if (!content.includes("opencode-tps-meter")) continue
      if (ext === ".ps1") fs.writeFileSync(wrapper, `& "$PSScriptRoot\\opencode.exe" @args\n`)
      else if (ext === ".cmd") fs.writeFileSync(wrapper, `@echo off\n"%~dp0opencode.exe" %*\n`)
      else {
        const stock = path.join(OPENCODE_BIN, "opencode-stock")
        if (fs.existsSync(stock)) fs.renameSync(stock, wrapper)
      }
      console.log(`  Restored: ${wrapper}`)
    } catch {}
  }

  // Also check ~/.local/bin on Unix
  if (!IS_WIN) {
    const localBin = path.join(HOME, ".local", "bin", "opencode")
    const localStock = path.join(HOME, ".local", "bin", "opencode-stock")
    try {
      if (fs.existsSync(localBin) && fs.readFileSync(localBin, "utf-8").includes("opencode-tps-meter")) {
        if (fs.existsSync(localStock)) fs.renameSync(localStock, localBin)
        else fs.unlinkSync(localBin)
        console.log(`  Restored: ${localBin}`)
      }
    } catch {}
  }

  try {
    fs.rmSync(tpsRoot, { recursive: true, force: true })
    console.log(`  Removed: ${tpsRoot}`)
  } catch (e: any) {
    console.error(`  Could not remove: ${e.message}. Close OpenCode first.`)
  }
  console.log("  Done. Run 'opencode' to verify.")
}

// ══════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════

console.log("")
console.log("  BetterToken Patcher")
console.log("  ───────────────────")
console.log("")

if (UNINSTALL_TPS) { uninstallTpsMeter(); process.exit(0) }
if (UNDO) { restoreStock(); process.exit(0) }

// Prerequisites
need("git", "https://git-scm.com")
need("bun", IS_WIN ? "irm bun.sh/install.ps1 | iex" : "curl -fsSL https://bun.sh/install | bash")
const bun = bunBin()

// Detect version
let version = detectVersion()
if (!version) {
  console.error("  Could not detect OpenCode version.")
  console.error("  Make sure OpenCode is installed: https://opencode.ai")
  process.exit(1)
}

console.log(`  OpenCode version: ${version}`)

if (!isSupported(version)) {
  console.log(`  Version ${version} not directly supported.`)
  console.log(`  Supported: ${printSupported()}`)
  console.log(`  Trying ${LATEST_SUPPORTED} patch...`)
  version = LATEST_SUPPORTED
}

const manifest = resolve(version)!
const releaseDir = path.join(RELEASES_DIR, version)

// Check if already installed
if (fs.existsSync(releaseDir)) {
  console.log("  Already installed. Use --undo to remove.")
  process.exit(0)
}

// Clone
console.log(`  Cloning OpenCode ${manifest.tag}...`)
fs.mkdirSync(RELEASES_DIR, { recursive: true })
const tmpDir = path.join(INSTALL_ROOT, `.tmp-${Date.now()}`)

try {
  runLoud(`git clone --depth 1 --branch ${manifest.tag} "${UPSTREAM_REPO}" "${tmpDir}"`)
} catch {
  console.error(`  Clone failed for tag ${manifest.tag}.`)
  process.exit(1)
}

// Download and apply patch
console.log("  Applying patch...")
const patchFile = path.join(INSTALL_ROOT, manifest.patch)

// Try local patch first (if running from repo), then download
const localPatch = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "patches", manifest.patch)
if (fs.existsSync(localPatch)) {
  fs.copyFileSync(localPatch, patchFile)
} else {
  const patchUrl = `${PATCHES_URL}/${manifest.patch}`
  console.log(`  Downloading patch from ${patchUrl}...`)
  try {
    runLoud(`curl -fsSL "${patchUrl}" -o "${patchFile}"`)
  } catch {
    // Try with PowerShell on Windows
    try {
      runLoud(`powershell -Command "Invoke-WebRequest -Uri '${patchUrl}' -OutFile '${patchFile}' -UseBasicParsing"`)
    } catch {
      console.error("  Could not download patch file.")
      fs.rmSync(tmpDir, { recursive: true, force: true })
      process.exit(1)
    }
  }
}

// Verify patch applies cleanly
const checkResult = run(`git apply --check "${patchFile}"`, tmpDir)
if (checkResult.includes("error")) {
  console.error("  Patch does not apply cleanly to this version.")
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
}

try {
  runLoud(`git apply "${patchFile}"`, tmpDir)
  console.log("  Patch applied.")
} catch {
  console.error("  git apply failed.")
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
}

// Install deps
console.log("  Installing dependencies...")
try {
  runLoud("bun install --frozen-lockfile", tmpDir)
} catch {
  try { runLoud("bun install", tmpDir) } catch {
    console.error("  bun install failed.")
    fs.rmSync(tmpDir, { recursive: true, force: true })
    process.exit(1)
  }
}

// Move to release dir
if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true, force: true })
fs.renameSync(tmpDir, releaseDir)

// Create wrappers
console.log("  Creating launcher...")
const sourceDir = path.join(releaseDir, "packages", "opencode")
createWrappers(sourceDir, bun)

// Cleanup
try { fs.unlinkSync(patchFile) } catch {}

console.log("")
console.log("  BetterToken patch installed!")
console.log("")
console.log(`  OpenCode ${version} running from patched source.`)
console.log("  Slots added: session_usage, session_footer")
console.log("")
console.log("  Restart OpenCode to activate.")
console.log("  Run with --undo to restore stock.")
console.log("")
