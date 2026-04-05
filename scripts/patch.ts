#!/usr/bin/env bun
/**
 * BetterToken Patcher
 *
 * Full installer: clones OpenCode source, applies slot patch, creates launcher.
 * Works on Windows, Mac, and Linux. Cross-platform replacement for TPS meter's
 * Linux-only install.sh.
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

const UPSTREAM_REPO = "https://github.com/anomalyco/opencode.git"
const MARKER = "bettertoken-patch"
const UNDO = process.argv.includes("--undo")
const UNINSTALL_TPS = process.argv.includes("--uninstall-tps")

const HOME = os.homedir()
const IS_WIN = process.platform === "win32"

// ── Paths ─────────────────────────────────────────────────────────────

const INSTALL_ROOT = IS_WIN
  ? path.join(HOME, "AppData", "Local", "bettertoken")
  : path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "bettertoken")

const RELEASES_DIR = path.join(INSTALL_ROOT, "releases")
const CURRENT_LINK = path.join(INSTALL_ROOT, "current")
const OPENCODE_BIN = path.join(HOME, ".opencode", "bin")

// ── Helpers ───────────────────────────────────────────────────────────

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e: any) {
    return ""
  }
}

function need(cmd: string, hint: string) {
  const found = IS_WIN
    ? run(`where ${cmd}`)
    : run(`command -v ${cmd}`)
  if (!found) {
    console.error(`  Missing required command: ${cmd}`)
    console.error(`  ${hint}`)
    process.exit(1)
  }
}

function detectVersion(): string {
  // Try stock binary
  const stockExe = path.join(OPENCODE_BIN, IS_WIN ? "opencode.exe" : "opencode")
  if (fs.existsSync(stockExe)) {
    const ver = run(`"${stockExe}" --version`)
    if (ver && /^\d+\.\d+\.\d+/.test(ver)) return ver.split(" ")[0]
  }
  // Try stock backup
  const stockBackup = path.join(OPENCODE_BIN, IS_WIN ? "opencode-stock.exe" : "opencode-stock")
  if (fs.existsSync(stockBackup)) {
    const ver = run(`"${stockBackup}" --version`)
    if (ver && /^\d+\.\d+\.\d+/.test(ver)) return ver.split(" ")[0]
  }
  // Try running opencode from PATH
  const ver = run("opencode --version")
  if (ver && /^\d+\.\d+\.\d+/.test(ver)) return ver.split(" ")[0]
  return ""
}

function promptPath(root: string): string {
  return path.join(root, "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx")
}

// ── Patch Logic ───────────────────────────────────────────────────────

function applyPatch(src: string): string {
  if (src.includes(MARKER) || src.includes('name="session_usage"')) {
    return src // Already patched
  }

  // Find the context/cost display line
  // Pattern: {[item().context, item().cost].filter(Boolean).join(" · ")}
  const pattern = /(\{)\s*(\[)\s*(item\(\)\.context\s*,\s*item\(\)\.cost\s*\]\s*\.filter\(Boolean\)\s*\.join\(\s*["'][^"']*["']\s*\))\s*(\})/

  if (!pattern.test(src)) {
    console.error("  Could not find context/cost pattern in prompt source.")
    console.error("  This OpenCode version may not be compatible.")
    process.exit(1)
  }

  // Wrap context/cost in session_usage slot
  src = src.replace(pattern, `{/* ${MARKER} */}
                          <TuiPluginRuntime.Slot name="session_usage" mode="replace" session_id={props.sessionID ?? ""}>
                            <span>{$2$3}</span>
                          </TuiPluginRuntime.Slot>`)

  // Add session_footer slot - find a good insertion point after the prompt area
  // Look for the Show/box pattern near the end of the component
  if (!src.includes('name="session_footer"')) {
    // Insert before the last return's outermost closing tag, or after status section
    // Find pattern: closing of the status/prompt section
    const footerPattern = /(\s*)(return\s*\([\s\S]*?)(\s*<\/box>\s*\)\s*\}?\s*$)/m
    
    // Simpler approach: find the last </box> before the component's closing
    // and insert session_footer before it
    const lines = src.split("\n")
    let insertIdx = -1
    
    // Find the line with the usage Match to insert footer after that section
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("</box>") && i > lines.length - 20) {
        // Check if this is near the end of the component
        insertIdx = i
        break
      }
    }
    
    if (insertIdx > 0) {
      const indent = "          "
      lines.splice(insertIdx, 0,
        `${indent}{/* ${MARKER}-footer */}`,
        `${indent}<Show when={props.sessionID}>`,
        `${indent}  {(sid) => <TuiPluginRuntime.Slot name="session_footer" session_id={sid()} />}`,
        `${indent}</Show>`
      )
      src = lines.join("\n")
    }
  }

  return src
}

// ── Create Wrappers ───────────────────────────────────────────────────

function createWrappers(releaseDir: string, bunBin: string) {
  const sourceDir = path.join(releaseDir, "packages", "opencode")
  
  if (!fs.existsSync(OPENCODE_BIN)) {
    fs.mkdirSync(OPENCODE_BIN, { recursive: true })
  }

  // Backup stock binary if not already backed up
  const stockExe = path.join(OPENCODE_BIN, IS_WIN ? "opencode.exe" : "opencode")
  const stockBackup = path.join(OPENCODE_BIN, IS_WIN ? "opencode-stock.exe" : "opencode-stock")
  if (fs.existsSync(stockExe) && !fs.existsSync(stockBackup)) {
    fs.copyFileSync(stockExe, stockBackup)
    console.log(`  Backed up stock binary: ${stockBackup}`)
  }

  if (IS_WIN) {
    // PowerShell wrapper
    const ps1 = path.join(OPENCODE_BIN, "opencode.ps1")
    fs.writeFileSync(ps1, `# BetterToken patched launcher
$env:OPENCODE_LAUNCH_CWD = (Get-Location).Path
$SourceDir = "${sourceDir}"
if (-not (Test-Path $SourceDir)) {
    Write-Warning "BetterToken source not found: $SourceDir"
    Write-Warning "Falling back to stock opencode..."
    & "$PSScriptRoot\\opencode-stock.exe" @args
    return
}
& "${bunBin}" --cwd $SourceDir --conditions=browser ./src/index.ts @args
`)
    console.log(`  Created: ${ps1}`)

    // CMD wrapper
    const cmd = path.join(OPENCODE_BIN, "opencode.cmd")
    fs.writeFileSync(cmd, `@echo off
rem BetterToken patched launcher
set "OPENCODE_LAUNCH_CWD=%CD%"
set "SOURCE_DIR=${sourceDir}"
if not exist "%SOURCE_DIR%" (
    echo BetterToken source not found: %SOURCE_DIR% 1>&2
    echo Falling back to stock opencode... 1>&2
    "%~dp0opencode-stock.exe" %*
    exit /b %ERRORLEVEL%
)
"${bunBin}" --cwd "%SOURCE_DIR%" --conditions=browser ./src/index.ts %*
`)
    console.log(`  Created: ${cmd}`)
  } else {
    // Unix shell wrapper
    const wrapper = path.join(OPENCODE_BIN, "opencode")
    fs.writeFileSync(wrapper, `#!/bin/sh
# BetterToken patched launcher
OPENCODE_LAUNCH_CWD="$(pwd)"
export OPENCODE_LAUNCH_CWD
SOURCE_DIR="${sourceDir}"
FALLBACK="${stockBackup}"
if [ ! -d "$SOURCE_DIR" ]; then
  if [ -x "$FALLBACK" ]; then
    exec "$FALLBACK" "$@"
  fi
  echo "BetterToken source not found: $SOURCE_DIR" >&2
  exit 1
fi
exec "${bunBin}" --cwd "$SOURCE_DIR" --conditions=browser ./src/index.ts "$@"
`)
    fs.chmodSync(wrapper, 0o755)
    console.log(`  Created: ${wrapper}`)
  }
}

// ── Restore Stock ─────────────────────────────────────────────────────

function restoreStock() {
  console.log("")
  console.log("  Restoring stock OpenCode...")
  console.log("")

  if (IS_WIN) {
    const stockBackup = path.join(OPENCODE_BIN, "opencode-stock.exe")
    if (fs.existsSync(stockBackup)) {
      // Restore wrappers to point to stock exe
      const ps1 = path.join(OPENCODE_BIN, "opencode.ps1")
      const cmd = path.join(OPENCODE_BIN, "opencode.cmd")
      fs.writeFileSync(ps1, `& "$PSScriptRoot\\opencode.exe" @args\n`)
      fs.writeFileSync(cmd, `@echo off\n"%~dp0opencode.exe" %*\n`)
      // Restore the backup as the main exe
      fs.copyFileSync(stockBackup, path.join(OPENCODE_BIN, "opencode.exe"))
      fs.unlinkSync(stockBackup)
      console.log("  Restored stock opencode.exe from backup")
    } else {
      // Just fix wrappers to point to exe
      const ps1 = path.join(OPENCODE_BIN, "opencode.ps1")
      const cmd = path.join(OPENCODE_BIN, "opencode.cmd")
      if (fs.existsSync(ps1)) fs.writeFileSync(ps1, `& "$PSScriptRoot\\opencode.exe" @args\n`)
      if (fs.existsSync(cmd)) fs.writeFileSync(cmd, `@echo off\n"%~dp0opencode.exe" %*\n`)
      console.log("  Restored launcher wrappers")
    }
  } else {
    const wrapper = path.join(OPENCODE_BIN, "opencode")
    const stockBackup = path.join(OPENCODE_BIN, "opencode-stock")
    if (fs.existsSync(stockBackup)) {
      fs.renameSync(stockBackup, wrapper)
      console.log("  Restored stock opencode from backup")
    } else {
      console.log("  No stock backup found. You may need to reinstall OpenCode.")
    }
  }

  // Remove bettertoken install directory
  if (fs.existsSync(INSTALL_ROOT)) {
    try {
      fs.rmSync(INSTALL_ROOT, { recursive: true, force: true })
      console.log(`  Removed: ${INSTALL_ROOT}`)
    } catch (e: any) {
      console.warn(`  Could not remove ${INSTALL_ROOT}: ${e.message}`)
    }
  }

  console.log("")
  console.log("  Stock OpenCode restored. Restart to apply.")
  console.log("")
}

// ── Uninstall TPS Meter ───────────────────────────────────────────────

function uninstallTpsMeter() {
  console.log("")
  console.log("  Uninstalling opencode-tps-meter...")
  console.log("")

  const tpsRoot = IS_WIN
    ? path.join(HOME, "AppData", "Local", "opencode-tps-meter")
    : path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "opencode-tps-meter")

  if (!fs.existsSync(tpsRoot)) {
    console.log("  opencode-tps-meter is not installed.")
    process.exit(0)
  }

  console.log(`  Found TPS meter at: ${tpsRoot}`)

  // Restore wrappers
  const wrappers = IS_WIN
    ? [
        path.join(OPENCODE_BIN, "opencode.ps1"),
        path.join(OPENCODE_BIN, "opencode.cmd"),
      ]
    : [path.join(HOME, ".local", "bin", "opencode")]

  for (const wrapper of wrappers) {
    try {
      if (!fs.existsSync(wrapper)) continue
      const content = fs.readFileSync(wrapper, "utf-8")
      if (!content.includes("opencode-tps-meter") && !content.includes("bettertoken")) continue

      if (wrapper.endsWith(".ps1")) {
        fs.writeFileSync(wrapper, `& "$PSScriptRoot\\opencode.exe" @args\n`)
      } else if (wrapper.endsWith(".cmd")) {
        fs.writeFileSync(wrapper, `@echo off\n"%~dp0opencode.exe" %*\n`)
      } else {
        const stock = path.join(path.dirname(wrapper), "opencode-stock")
        if (fs.existsSync(stock)) {
          fs.renameSync(stock, wrapper)
        } else {
          fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${path.dirname(wrapper)}/opencode" "$@"\n`)
          fs.chmodSync(wrapper, 0o755)
        }
      }
      console.log(`  Restored: ${wrapper}`)
    } catch {}
  }

  // Remove TPS meter directory
  try {
    fs.rmSync(tpsRoot, { recursive: true, force: true })
    console.log(`  Removed: ${tpsRoot}`)
  } catch (e: any) {
    console.error(`  Could not remove ${tpsRoot}: ${e.message}`)
    console.error("  Close OpenCode first, then try again.")
  }

  console.log("")
  console.log("  opencode-tps-meter uninstalled.")
  console.log("  Run 'opencode' to verify stock OpenCode works.")
  console.log("")
}

// ══════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════

if (UNINSTALL_TPS) {
  uninstallTpsMeter()
  process.exit(0)
}

if (UNDO) {
  restoreStock()
  process.exit(0)
}

console.log("")
console.log("  BetterToken Patcher")
console.log("  ───────────────────")
console.log("")

// ── Prerequisites ─────────────────────────────────────────────────────

need("git", "Install git: https://git-scm.com")
need("bun", IS_WIN ? "Install bun: irm bun.sh/install.ps1 | iex" : "Install bun: curl -fsSL https://bun.sh/install | bash")

const bunBin = IS_WIN ? run("where bun").split("\n")[0] : run("command -v bun")
if (!bunBin) {
  console.error("  Could not locate bun binary.")
  process.exit(1)
}

// ── Detect version ────────────────────────────────────────────────────

const version = detectVersion()
if (!version) {
  console.error("  Could not detect OpenCode version.")
  console.error("  Make sure OpenCode is installed: https://opencode.ai")
  process.exit(1)
}

console.log(`  OpenCode version: ${version}`)

// Check if already installed
const releaseDir = path.join(RELEASES_DIR, version)
if (fs.existsSync(releaseDir)) {
  const prompt = promptPath(releaseDir)
  if (fs.existsSync(prompt)) {
    const src = fs.readFileSync(prompt, "utf-8")
    if (src.includes(MARKER)) {
      console.log("  Already patched. Nothing to do.")
      console.log("  Use --undo to remove the patch.")
      process.exit(0)
    }
  }
}

// ── Clone source ──────────────────────────────────────────────────────

const tag = `v${version}`
console.log(`  Cloning OpenCode ${tag}...`)

fs.mkdirSync(RELEASES_DIR, { recursive: true })
const tmpDir = path.join(INSTALL_ROOT, `.install-${Date.now()}`)

try {
  const cloneResult = run(`git clone --depth 1 --branch ${tag} "${UPSTREAM_REPO}" "${tmpDir}"`)
  if (!fs.existsSync(path.join(tmpDir, "package.json"))) {
    console.error(`  Failed to clone OpenCode ${tag}.`)
    console.error("  This version may not exist. Check https://github.com/anomalyco/opencode/tags")
    process.exit(1)
  }
  console.log("  Clone complete.")
} catch (e: any) {
  console.error(`  Clone failed: ${e.message}`)
  process.exit(1)
}

// ── Apply patch ───────────────────────────────────────────────────────

const prompt = promptPath(tmpDir)
if (!fs.existsSync(prompt)) {
  console.error(`  Prompt file not found in source: ${prompt}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
}

console.log("  Applying patch...")
const original = fs.readFileSync(prompt, "utf-8")
const patched = applyPatch(original)

if (patched === original) {
  console.log("  Source already has session_usage slot (from another patch).")
} else {
  fs.writeFileSync(prompt, patched)
  console.log("  Patch applied: session_usage + session_footer slots added.")
}

// ── Install dependencies ──────────────────────────────────────────────

console.log("  Installing dependencies (bun install)...")
try {
  execSync("bun install --frozen-lockfile", { cwd: tmpDir, stdio: "inherit" })
} catch {
  // Try without frozen lockfile
  try {
    execSync("bun install", { cwd: tmpDir, stdio: "inherit" })
  } catch (e: any) {
    console.error(`  bun install failed: ${e.message}`)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    process.exit(1)
  }
}

// ── Move to release directory ─────────────────────────────────────────

if (fs.existsSync(releaseDir)) {
  fs.rmSync(releaseDir, { recursive: true, force: true })
}
fs.renameSync(tmpDir, releaseDir)

// Create/update "current" symlink/junction
if (fs.existsSync(CURRENT_LINK)) {
  try { fs.rmSync(CURRENT_LINK, { recursive: true, force: true }) } catch {}
}
try {
  if (IS_WIN) {
    execSync(`cmd /c mklink /J "${CURRENT_LINK}" "${releaseDir}"`, { stdio: "pipe" })
  } else {
    fs.symlinkSync(releaseDir, CURRENT_LINK)
  }
} catch {
  // Junction/symlink failed, just write a pointer file
  fs.writeFileSync(CURRENT_LINK + ".path", releaseDir)
}

// ── Create launcher wrappers ──────────────────────────────────────────

console.log("  Creating launcher wrappers...")
createWrappers(releaseDir, bunBin)

console.log("")
console.log("  ✓ BetterToken patch installed!")
console.log("")
console.log(`  OpenCode ${version} is now running from patched source.`)
console.log("  Added slots: session_usage, session_footer")
console.log("")
console.log("  Restart OpenCode to activate.")
console.log("  Use --undo to restore stock OpenCode.")
console.log("")
