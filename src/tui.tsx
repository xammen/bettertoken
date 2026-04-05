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
      const srcRoot = path.resolve(path.dirname(process.argv[1]), "..")
      const promptFile = path.join(srcRoot, "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx")
      try {
        const src = fs.readFileSync(promptFile, "utf-8")
        if (src.includes('name="session_usage"')) patchInstalled = true
      } catch {}
    }
  } catch {}

  api.slots.register({
    slots: {
      sidebar_title(_ctx: any, props: any) {
        // Capture session titles as they appear in the sidebar
        if (props.session_id && props.title) cacheTitle(props.session_id, props.title)
        return null // Don't modify the title display
      },
      sidebar_footer() {
        const p = cfg().placement
        if (p !== "sidebar" && p !== "footer") return null
        return <FooterView api={api} cfg={cfg} tick={tick} />
      },
      session_footer() {
        if (cfg().placement !== "footer") return null
        return <FooterView api={api} cfg={cfg} tick={tick} />
      },
      session_usage(_ctx: any, props: any) {
        if (cfg().placement !== "inline") return null
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
