/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import {
  DEFAULTS,
  loadCfg,
  record,
  showMain,
  refreshTitles,
  cacheTitle,
  setPatchInstalled,
  FooterView,
  InlineView,
} from "./logic"
import type { Config } from "./logic"

const tui: TuiPlugin = (api, raw) => {
  const initial = { ...DEFAULTS, ...(raw as Partial<Config> | undefined) }
  const [cfg, setCfg] = createSignal<Config>(loadCfg(api, initial))
  const [tick, setTick] = createSignal(0)
  const interval = setInterval(() => setTick((t) => t + 1), 2000)
  api.lifecycle.onDispose(() => clearInterval(interval))

  api.command.register(() => [
    {
      title: "BetterToken",
      value: "bettertoken.stats",
      description: "View token usage & settings",
      category: "Plugin",
      slash: { name: "bettertoken" },
      onSelect: () => {
        try {
          showMain(api, cfg, setCfg, tick)
        } catch (e: any) {
          api.ui.toast({ variant: "danger", message: `BetterToken error: ${e?.message ?? e}` })
        }
      },
    },
  ])

  api.event.on("message.updated", (evt) => {
    const msg = evt.properties.info
    if (msg.role !== "assistant") return
    if (!msg.time.completed) return
    if (msg.tokens.output <= 0) return
    record(api, msg as AssistantMessage)
  })

  // Refresh session titles on startup (non-blocking)
  setTimeout(() => refreshTitles(api), 3000)

  // Detect if inline patch is installed
  let patchInstalled = false
  try {
    if (typeof process !== "undefined" && process.argv[1]) {
      const fs = require("node:fs")
      const path = require("node:path")
      // argv[1] is like .../packages/opencode/src/index.ts
      // We need to go up to the release root, then into the prompt component
      const argv1Dir = path.dirname(process.argv[1])
      const candidates = [
        path.resolve(argv1Dir, "cli", "cmd", "tui", "component", "prompt", "index.tsx"),
        path.resolve(argv1Dir, "..", "cli", "cmd", "tui", "component", "prompt", "index.tsx"),
        path.resolve(argv1Dir, "..", "..", "..", "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx"),
      ]
      for (const candidate of candidates) {
        try {
          const src = fs.readFileSync(candidate, "utf-8")
          if (src.includes('name="session_usage"')) { patchInstalled = true; break }
        } catch {}
      }
    }
  } catch {}

  // Inform logic of patch status
  setPatchInstalled(patchInstalled)

  // Warn if inline placement but no patch
  if (!patchInstalled && cfg().placement === "inline") {
    api.ui.toast({ variant: "warning", message: "BetterToken: inline mode requires patched OpenCode. Falling back to sidebar.", duration: 5000 })
  }

  api.slots.register({
    slots: {
      sidebar_title(_ctx: any, props: any) {
        // Capture session titles as they appear in the sidebar
        if (props.session_id && props.title) cacheTitle(props.session_id, props.title)
        return null // Don't modify the title display
      },
      sidebar_footer() {
        const p = cfg().placement
        // Show in sidebar for: sidebar mode, footer mode, or inline fallback when no patch
        if (p === "sidebar" || p === "footer") return <FooterView api={api} cfg={cfg} tick={tick} />
        if (p === "inline" && !patchInstalled) return <FooterView api={api} cfg={cfg} tick={tick} />
        return null
      },
      session_footer() {
        const p = cfg().placement
        if (p === "footer") return <FooterView api={api} cfg={cfg} tick={tick} />
        if (p === "inline" && !patchInstalled) return <FooterView api={api} cfg={cfg} tick={tick} />
        return null
      },
      session_usage(_ctx: any, props: any) {
        if (cfg().placement !== "inline" || !patchInstalled) return null
        return <InlineView api={api} cfg={cfg} sid={props.session_id} tick={tick} />
      },
    } as any,
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "bettertoken",
  tui,
}

export default plugin
