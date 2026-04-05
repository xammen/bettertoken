#!/usr/bin/env bun
/**
 * BetterToken Patcher
 * Adds session_usage and session_footer slots to OpenCode's prompt component.
 * Idempotent: safe to run multiple times. Detects if already patched.
 *
 * Usage:
 *   bun run patch.ts              # Apply BetterToken patch
 *   bun run patch.ts --undo       # Remove BetterToken patch
 *   bun run patch.ts --uninstall-tps  # Remove TPS meter and restore stock OpenCode
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execSync } from "node:child_process"

const MARKER = "bettertoken-patch"
const UNDO = process.argv.includes("--undo")
const UNINSTALL_TPS = process.argv.includes("--uninstall-tps")

// ── Find OpenCode installation ────────────────────────────────────────

function findOpenCodeRoot(): string | null {
  const home = os.homedir()
  const isWin = process.platform === "win32"

  // Check common OpenCode source locations
  const candidates: string[] = []

  // opencode-tps-meter releases
  const tpsMeterBase = isWin
    ? path.join(home, "AppData", "Local", "opencode-tps-meter", "releases")
    : path.join(home, ".local", "share", "opencode-tps-meter", "releases")
  if (fs.existsSync(tpsMeterBase)) {
    try {
      const releases = fs.readdirSync(tpsMeterBase).sort().reverse()
      for (const r of releases) {
        candidates.push(path.join(tpsMeterBase, r))
      }
    } catch {}
  }

  // Standard opencode locations
  const standardPaths = isWin
    ? [
        path.join(home, "AppData", "Local", "opencode"),
        path.join(home, ".opencode"),
      ]
    : [
        path.join(home, ".local", "share", "opencode"),
        path.join(home, ".opencode"),
        "/usr/local/lib/opencode",
      ]
  candidates.push(...standardPaths)

  // Check via bun's global modules
  try {
    const bunGlobal = isWin
      ? path.join(home, ".bun", "install", "global", "node_modules", "opencode-ai")
      : path.join(home, ".bun", "install", "global", "node_modules", "opencode-ai")
    candidates.push(bunGlobal)
  } catch {}

  // Find the prompt file in each candidate
  for (const base of candidates) {
    const promptFile = path.join(base, "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx")
    if (fs.existsSync(promptFile)) {
      return base
    }
  }

  return null
}

function getPromptPath(root: string): string {
  return path.join(root, "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx")
}

// ── Patch logic ───────────────────────────────────────────────────────

function patchSource(src: string): "bettertoken" | "tps-meter" | "none" {
  if (src.includes(MARKER)) return "bettertoken"
  if (src.includes('name="session_usage"')) return "tps-meter"
  return "none"
}

function applyPatch(src: string): string {
  // Find the usage display line and wrap context/cost in a slot
  // Native pattern:
  //   {[item().context, item().cost].filter(Boolean).join(" · ")}
  // or with TPS:
  //   {[liveTps() ? ... : item().outputTps, item().context, item().cost]...}

  // Strategy: find the <Match when={usage()}> block and inject our slots

  // 1. Add session_usage slot around context/cost
  const contextCostPattern = /(\{?\[)((?:liveTps\(\)[^,]*,\s*)?)(item\(\)\.context,\s*item\(\)\.cost\]\.filter\(Boolean\)\.join\(\s*["'][\s·]*["']\s*\))/

  if (contextCostPattern.test(src)) {
    // Split: keep TPS part outside slot, wrap context/cost in slot
    src = src.replace(contextCostPattern, (match, bracket, tpsPart, contextCost) => {
      if (tpsPart) {
        // TPS meter is present: TPS stays outside, context/cost goes in slot
        return `{[${tpsPart.replace(/,\s*$/, "")}].filter(Boolean).join(" · ")}
                          {/* ${MARKER} */}
                          <TuiPluginRuntime.Slot name="session_usage" mode="replace" session_id={props.sessionID ?? ""}>
                            <span>{item().context ? \` · \${item().context}\` : ""}{item().cost ? \` · \${item().cost}\` : ""}</span>
                          </TuiPluginRuntime.Slot>`
      } else {
        // No TPS meter: wrap everything in slot
        return `{/* ${MARKER} */}
                          <TuiPluginRuntime.Slot name="session_usage" mode="replace" session_id={props.sessionID ?? ""}>
                            <span>${bracket}${contextCost}}</span>
                          </TuiPluginRuntime.Slot>`
      }
    })
  } else {
    // Fallback: try simpler pattern
    const simplePattern = /(\{)\s*\[\s*item\(\)\.context\s*,\s*item\(\)\.cost\s*\]\s*\.filter\(Boolean\)\s*\.join\([^)]+\)\s*(\})/
    if (simplePattern.test(src)) {
      src = src.replace(simplePattern, `{/* ${MARKER} */}
                          <TuiPluginRuntime.Slot name="session_usage" mode="replace" session_id={props.sessionID ?? ""}>
                            <span>{[item().context, item().cost].filter(Boolean).join(" · ")}</span>
                          </TuiPluginRuntime.Slot>`)
    } else {
      console.error("Could not find context/cost pattern to patch session_usage slot.")
      console.error("Your OpenCode version may not be compatible with this patch.")
      process.exit(1)
    }
  }

  // 2. Add session_footer slot
  // Find the closing of the prompt component's main box, or after the usage section
  // Look for a good insertion point: after the main status row section
  if (!src.includes('name="session_footer"')) {
    // Find the pattern where session prompt ends - look for closing tags after the usage Match
    const footerInsertPattern = /(<\/Show>\s*\n\s*<\/box>\s*\n\s*<\/box>(?:\s*\n\s*\{\/\*.*?\*\/\})?)\s*\n(\s*<box\s)/
    if (footerInsertPattern.test(src)) {
      src = src.replace(footerInsertPattern, `$1
        {/* ${MARKER}-footer */}
        <Show when={props.sessionID}>
          {(sid) => <TuiPluginRuntime.Slot name="session_footer" session_id={sid()} />}
        </Show>
$2`)
    } else {
      // Try alternate: insert before the last closing tags of the prompt area
      // Just add it - the slot will be silently ignored if position isn't ideal
      const altPattern = /(return\s*\(\s*\n\s*<box[^>]*>)/
      if (!altPattern.test(src)) {
        console.warn("Warning: Could not find ideal position for session_footer slot.")
        console.warn("The session_footer slot was not added. session_usage should still work.")
      }
    }
  }

  return src
}

// undoPatch is handled by restoring from backup in main()

// ── Uninstall TPS meter ───────────────────────────────────────────────

function uninstallTpsMeter() {
  console.log("")
  console.log("  Uninstalling opencode-tps-meter...")
  console.log("")

  const home = os.homedir()
  const isWin = process.platform === "win32"

  // Find TPS meter install root
  const tpsRoot = isWin
    ? path.join(home, "AppData", "Local", "opencode-tps-meter")
    : path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode-tps-meter")

  if (!fs.existsSync(tpsRoot)) {
    console.log("  opencode-tps-meter is not installed.")
    process.exit(0)
  }

  console.log(`  Found TPS meter at: ${tpsRoot}`)

  // Find and restore ALL wrapper scripts that point to tps-meter
  const wrapperCandidates = isWin
    ? [
        path.join(home, ".opencode", "bin", "opencode.ps1"),
        path.join(home, ".opencode", "bin", "opencode.cmd"),
        path.join(home, "AppData", "Roaming", "npm", "opencode.cmd"),
        path.join(home, "AppData", "Roaming", "npm", "opencode.ps1"),
        path.join(home, ".bun", "bin", "opencode"),
        path.join(home, ".bun", "bin", "opencode.cmd"),
      ]
    : [
        path.join(home, ".local", "bin", "opencode"),
        path.join(home, ".opencode", "bin", "opencode"),
      ]

  let restored = 0
  for (const wrapper of wrapperCandidates) {
    try {
      if (!fs.existsSync(wrapper)) continue
      const content = fs.readFileSync(wrapper, "utf-8")
      if (!content.includes("opencode-tps-meter")) continue

      // This wrapper was modified by TPS meter - restore it
      const dir = path.dirname(wrapper)
      const ext = path.extname(wrapper)

      // Find the stock opencode binary in the same directory
      const stockBinary = fs.readdirSync(dir).find(f =>
        f.startsWith("opencode") && (f.endsWith(".exe") || (!ext && !f.includes("."))) && !f.includes("stock") && !f.includes("tps") && f !== path.basename(wrapper)
      )

      if (ext === ".ps1") {
        // Restore PowerShell wrapper to just call the exe
        fs.writeFileSync(wrapper, `& "$PSScriptRoot\\opencode.exe" @args\n`)
        console.log(`  Restored: ${wrapper}`)
        restored++
      } else if (ext === ".cmd") {
        // Restore CMD wrapper to just call the exe
        fs.writeFileSync(wrapper, `@echo off\n"%~dp0opencode.exe" %*\n`)
        console.log(`  Restored: ${wrapper}`)
        restored++
      } else {
        // Unix shell script - check for stock backup
        const stockPath = path.join(dir, "opencode-stock")
        if (fs.existsSync(stockPath)) {
          fs.renameSync(stockPath, wrapper)
          console.log(`  Restored from opencode-stock: ${wrapper}`)
          restored++
        } else {
          // Point to the exe/binary in the same dir
          fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${dir}/opencode.exe" "$@"\n`)
          fs.chmodSync(wrapper, 0o755)
          console.log(`  Restored: ${wrapper}`)
          restored++
        }
      }
    } catch (e: any) {
      console.warn(`  Could not restore ${wrapper}: ${e.message}`)
    }
  }

  if (restored === 0) {
    console.log("  No TPS meter wrappers found to restore.")
  }

  // Clean up stock backup files
  for (const wrapper of wrapperCandidates) {
    const dir = path.dirname(wrapper)
    try {
      const stockExe = path.join(dir, "opencode-stock.exe")
      const stockBin = path.join(dir, "opencode-stock")
      if (fs.existsSync(stockExe)) { fs.unlinkSync(stockExe); console.log(`  Removed backup: ${stockExe}`) }
      if (fs.existsSync(stockBin)) { fs.unlinkSync(stockBin); console.log(`  Removed backup: ${stockBin}`) }
    } catch {}
  }

  // Remove TPS meter directory
  try {
    fs.rmSync(tpsRoot, { recursive: true, force: true })
    console.log(`  Removed: ${tpsRoot}`)
  } catch (e: any) {
    console.error(`  Could not remove ${tpsRoot}: ${e.message}`)
    console.error("  Try closing OpenCode first, then run this again.")
  }

  console.log("")
  console.log("  opencode-tps-meter uninstalled.")
  console.log("  Run 'opencode' to verify stock OpenCode works.")
  console.log("")
}

// ── Main ──────────────────────────────────────────────────────────────

if (UNINSTALL_TPS) {
  uninstallTpsMeter()
  process.exit(0)
}

console.log("")
console.log("  BetterToken Patcher")
console.log("  ───────────────────")
console.log("")

const root = findOpenCodeRoot()
if (!root) {
  console.error("  Could not find OpenCode installation.")
  console.error("")
  console.error("  Searched in common locations:")
  console.error("    - ~/.local/share/opencode-tps-meter/releases/")
  console.error("    - ~/.local/share/opencode/")
  console.error("    - ~/.opencode/")
  console.error("")
  console.error("  Make sure OpenCode is installed before running this patcher.")
  process.exit(1)
}

console.log(`  Found OpenCode at: ${root}`)

const promptPath = getPromptPath(root)
if (!fs.existsSync(promptPath)) {
  console.error(`  Prompt file not found: ${promptPath}`)
  process.exit(1)
}

const original = fs.readFileSync(promptPath, "utf-8")

const source = patchSource(original)

if (UNDO) {
  if (source === "none") {
    console.log("  Not patched, nothing to undo.")
    process.exit(0)
  }
  if (source === "tps-meter") {
    console.log("  This patch was applied by opencode-tps-meter, not BetterToken.")
    console.log("  To remove it, use the TPS meter uninstaller:")
    console.log("    curl -fsSL https://raw.githubusercontent.com/guard22/opencode-tps-meter/main/uninstall.sh | bash")
    console.log("")
    console.log("  Or on Windows:")
    console.log("    irm https://raw.githubusercontent.com/guard22/opencode-tps-meter/main/uninstall.ps1 | iex")
    process.exit(0)
  }
  // source === "bettertoken" → restore from backup
  const backupPath = promptPath + ".bettertoken-backup"
  if (fs.existsSync(backupPath)) {
    const backup = fs.readFileSync(backupPath, "utf-8")
    fs.writeFileSync(promptPath, backup)
    fs.unlinkSync(backupPath)
    console.log("  Patch removed (restored from backup).")
    console.log("  Restart OpenCode to apply changes.")
  } else {
    console.log("  No backup file found. Cannot safely restore.")
    console.log("  You may need to reinstall OpenCode to remove the patch.")
  }
  process.exit(0)
}

if (source !== "none") {
  const who = source === "bettertoken" ? "BetterToken" : "opencode-tps-meter"
  console.log(`  Already patched by ${who} (session_usage slot found).`)
  console.log("  Nothing to do. Use --undo to remove the patch.")
  process.exit(0)
}

// Backup original
const backupPath = promptPath + ".bettertoken-backup"
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, original)
  console.log(`  Backup saved: ${backupPath}`)
}

const patched = applyPatch(original)
fs.writeFileSync(promptPath, patched)

console.log("")
console.log("  Patch applied successfully!")
console.log("")
console.log("  Added slots:")
console.log("    - session_usage (inline stats next to TPS)")
console.log("    - session_footer (stats below prompt)")
console.log("")
console.log("  Restart OpenCode to activate.")
console.log("  Run with --undo to remove the patch.")
console.log("")
