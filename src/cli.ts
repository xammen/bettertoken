#!/usr/bin/env bun
import fs from "node:fs"
import path from "node:path"

const SLOT_MARKER = 'name="session_usage"'

// ── Patch fragments ───────────────────────────────────────────────────

const SLOT_TYPE_PATCH = {
  search: `  sidebar_footer: {\n    session_id: string\n  }\n}`,
  replace: `  sidebar_footer: {\n    session_id: string\n  }\n  session_usage: {\n    session_id: string\n  }\n}`,
}

const PROMPT_IMPORT_PATCH = {
  search: `import { DialogSkill } from "../dialog-skill"`,
  replace: `import { DialogSkill } from "../dialog-skill"\nimport { TuiPluginRuntime } from "../../plugin"`,
}

// Patch the usage display to wrap context/cost in a replaceable slot
const PROMPT_USAGE_PATCH = {
  // Match the Switch block containing the usage display
  search: `                  <Switch>
                    <Match when={usage()}>
                      {(item) => (
                        <text fg={theme.textMuted} wrapMode="none">
                          {[liveTps() ? \`~\${liveTps()}\` : item().outputTps, item().context, item().cost]
                            .filter(Boolean)
                            .join(" \u00b7 ")}
                        </text>
                      )}
                    </Match>
                    <Match when={true}>
                      <text fg={theme.text}>
                        {keybind.print("agent_cycle")} <span style={{ fg: theme.textMuted }}>agents</span>
                      </text>
                    </Match>
                  </Switch>`,
  replace: `                  <Switch>
                    <Match when={usage()}>
                      {(item) => (
                        <text fg={theme.textMuted} wrapMode="none">
                          {[liveTps() ? \`~\${liveTps()}\` : item().outputTps].filter(Boolean).join(" \u00b7 ")}
                          <TuiPluginRuntime.Slot name="session_usage" mode="replace" session_id={props.sessionID ?? ""}>
                            <span>{item().context ? \` \u00b7 \${item().context}\` : ""}{item().cost ? \` \u00b7 \${item().cost}\` : ""}</span>
                          </TuiPluginRuntime.Slot>
                        </text>
                      )}
                    </Match>
                    <Match when={true}>
                      <text fg={theme.text}>
                        {keybind.print("agent_cycle")} <span style={{ fg: theme.textMuted }}>agents</span>
                      </text>
                    </Match>
                  </Switch>`,
}

// ── Find OpenCode source ──────────────────────────────────────────────

function findOpenCodeRoot(): string | null {
  // Check common locations
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const candidates = [
    // TPS meter patched install
    path.join(home, "AppData", "Local", "opencode-tps-meter", "current"),
    path.join(home, ".local", "share", "opencode-tps-meter", "current"),
    // Standard bun global install
    path.join(home, ".bun", "install", "global", "node_modules", "opencode"),
    path.join(home, "AppData", "Local", "npm-cache", "opencode"),
  ]

  // Also try to find from the opencode binary
  try {
    const which = require("child_process").execSync(
      process.platform === "win32" ? "where.exe opencode" : "which opencode",
      { encoding: "utf-8" }
    ).trim().split("\n")[0]
    if (which) {
      // Read the wrapper to find the source dir
      const content = fs.readFileSync(which, "utf-8")
      const match = content.match(/--cwd\s+"?([^"]+)"?/)
      if (match) candidates.unshift(path.resolve(match[1], "..", ".."))
    }
  } catch {}

  for (const dir of candidates) {
    const promptFile = path.join(dir, "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx")
    if (fs.existsSync(promptFile)) return dir
  }
  return null
}

// ── Patch / Unpatch ───────────────────────────────────────────────────

function applyPatch(root: string): boolean {
  const promptFile = path.join(root, "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx")
  const slotFile = path.join(root, "packages", "plugin", "src", "tui.ts")

  // Check if already patched
  const promptSrc = fs.readFileSync(promptFile, "utf-8")
  if (promptSrc.includes(SLOT_MARKER)) {
    console.log("Already patched!")
    return true
  }

  let ok = true

  // Patch slot types
  if (fs.existsSync(slotFile)) {
    let src = fs.readFileSync(slotFile, "utf-8")
    if (src.includes(SLOT_TYPE_PATCH.search)) {
      src = src.replace(SLOT_TYPE_PATCH.search, SLOT_TYPE_PATCH.replace)
      fs.writeFileSync(slotFile, src, "utf-8")
      console.log("  Patched: TuiSlotMap (added session_usage)")
    } else {
      console.warn("  Warning: Could not find slot type insertion point")
      ok = false
    }
  }

  // Patch prompt import
  let src = promptSrc
  if (src.includes(PROMPT_IMPORT_PATCH.search) && !src.includes("TuiPluginRuntime")) {
    src = src.replace(PROMPT_IMPORT_PATCH.search, PROMPT_IMPORT_PATCH.replace)
    console.log("  Patched: Prompt import (added TuiPluginRuntime)")
  }

  // Patch prompt usage
  if (src.includes(PROMPT_USAGE_PATCH.search)) {
    src = src.replace(PROMPT_USAGE_PATCH.search, PROMPT_USAGE_PATCH.replace)
    console.log("  Patched: Prompt usage (wrapped in session_usage slot)")
  } else {
    console.warn("  Warning: Could not find prompt usage insertion point")
    console.warn("  This may mean your OpenCode version is not compatible.")
    ok = false
  }

  if (ok) {
    fs.writeFileSync(promptFile, src, "utf-8")
    console.log("\nInline patch installed successfully!")
    console.log("Restart OpenCode to see the changes.")
  }

  return ok
}

function removePatch(root: string): boolean {
  const promptFile = path.join(root, "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx")
  const slotFile = path.join(root, "packages", "plugin", "src", "tui.ts")

  let src = fs.readFileSync(promptFile, "utf-8")
  if (!src.includes(SLOT_MARKER)) {
    console.log("Not patched, nothing to remove.")
    return true
  }

  // Reverse prompt usage patch
  if (src.includes(PROMPT_USAGE_PATCH.replace)) {
    src = src.replace(PROMPT_USAGE_PATCH.replace, PROMPT_USAGE_PATCH.search)
  }

  // Reverse prompt import patch
  if (src.includes(PROMPT_IMPORT_PATCH.replace)) {
    src = src.replace(PROMPT_IMPORT_PATCH.replace, PROMPT_IMPORT_PATCH.search)
  }

  fs.writeFileSync(promptFile, src, "utf-8")

  // Reverse slot types
  if (fs.existsSync(slotFile)) {
    let slotSrc = fs.readFileSync(slotFile, "utf-8")
    if (slotSrc.includes(SLOT_TYPE_PATCH.replace)) {
      slotSrc = slotSrc.replace(SLOT_TYPE_PATCH.replace, SLOT_TYPE_PATCH.search)
      fs.writeFileSync(slotFile, slotSrc, "utf-8")
    }
  }

  console.log("Inline patch removed. Restart OpenCode.")
  console.log("BetterToken will still work in footer mode.")
  return true
}

function initConfig(): void {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const configDir = path.join(home, ".config", "opencode")
  const configFile = path.join(configDir, "tui.json")

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })

  let config: any = {}
  if (fs.existsSync(configFile)) {
    try { config = JSON.parse(fs.readFileSync(configFile, "utf-8")) } catch {}
  }

  if (!config.plugin) config.plugin = []
  const existing = config.plugin.find((p: any) => {
    const name = Array.isArray(p) ? p[0] : p
    return typeof name === "string" && name.includes("bettertoken")
  })

  if (existing) {
    console.log("BetterToken already configured in tui.json")
    return
  }

  config.plugin.push(["bettertoken", {}])
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf-8")
  console.log(`Added BetterToken to ${configFile}`)
  console.log("Restart OpenCode to load the plugin.")
}

function status(root: string | null): void {
  console.log("BetterToken Status")
  console.log("==================")
  if (root) {
    console.log(`OpenCode source: ${root}`)
    const promptFile = path.join(root, "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx")
    try {
      const src = fs.readFileSync(promptFile, "utf-8")
      console.log(`Inline patch:   ${src.includes(SLOT_MARKER) ? "installed" : "not installed"}`)
    } catch {
      console.log("Inline patch:   unknown (cannot read source)")
    }
  } else {
    console.log("OpenCode source: not found")
    console.log("Inline patch:   not installed")
  }
  console.log(`Mode:           ${root ? "inline + sidebar" : "sidebar only (footer fallback)"}`)
}

// ── Main ──────────────────────────────────────────────────────────────

const cmd = process.argv[2]

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`
BetterToken - Token usage tracker for OpenCode

Commands:
  bettertoken init      Add BetterToken to your tui.json config
  bettertoken patch     Install the inline footer patch (shows stats next to TPS)
  bettertoken unpatch   Remove the inline footer patch
  bettertoken status    Show current installation status
  bettertoken help      Show this help

Without the patch, BetterToken shows stats in the session footer (below).
With the patch, stats appear inline next to the TPS meter and context %.
`)
  process.exit(0)
}

if (cmd === "init") {
  initConfig()
  process.exit(0)
}

if (cmd === "status") {
  status(findOpenCodeRoot())
  process.exit(0)
}

if (cmd === "patch" || cmd === "unpatch") {
  const root = findOpenCodeRoot()
  if (!root) {
    console.error("Could not find OpenCode source installation.")
    console.error("Make sure OpenCode is installed and accessible.")
    process.exit(1)
  }
  console.log(`Found OpenCode at: ${root}\n`)
  const ok = cmd === "patch" ? applyPatch(root) : removePatch(root)
  process.exit(ok ? 0 : 1)
}

console.error(`Unknown command: ${cmd}. Run 'bettertoken help' for usage.`)
process.exit(1)
