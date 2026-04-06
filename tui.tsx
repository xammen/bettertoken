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
  rememberTitle,
  FooterView,
  PromptView,
} from "./logic"
import type { Config } from "./logic"

const tui: TuiPlugin = (api, raw) => {
  const initial = { ...DEFAULTS, ...(raw as Partial<Config> | undefined) }
  const [cfg, setCfg] = createSignal<Config>(loadCfg(api, initial))
  const [tick, setTick] = createSignal(0)
  const interval = setInterval(() => setTick((t) => t + 1), 2000)
  const titleRefresh = setInterval(() => refreshTitles(api).catch(() => {}), 10000)
  api.lifecycle.onDispose(() => clearInterval(interval))
  api.lifecycle.onDispose(() => clearInterval(titleRefresh))

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

  api.slots.register({
    slots: {
      // Capture session titles from sidebar
      sidebar_title(_ctx: any, props: any) {
        if (props.session_id && props.title) rememberTitle(api, props.session_id, props.title)
        return null
      },
      // Show stats in sidebar footer
      sidebar_footer() {
        return <FooterView api={api} cfg={cfg} tick={tick} />
      },
      // Show stats in the prompt area (like TPS meter) - THIS IS THE KEY!
      session_prompt_right(ctx: any, props: any) {
        const sessionID = props.session_id
        return <PromptView api={api} cfg={cfg} tick={tick} sessionID={sessionID} />
      },
    } as any,
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "bettertoken",
  tui,
}

export default plugin
