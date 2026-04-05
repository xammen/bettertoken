/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import {
  DEFAULTS,
  loadCfg,
  record,
  showMain,
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
      onSelect: () => showMain(api, cfg, setCfg),
    },
  ])

  api.event.on("message.updated", (evt) => {
    const msg = evt.properties.info
    if (msg.role !== "assistant") return
    if (!msg.time.completed) return
    if (msg.tokens.output <= 0) return
    record(api, msg as AssistantMessage)
  })

  api.slots.register({
    order: 50,
    slots: {
      sidebar_footer() {
        return <FooterView api={api} cfg={cfg} tick={tick} />
      },
      session_usage(_ctx: any, props: any) {
        return <InlineView api={api} cfg={cfg} sid={props.session_id} tick={tick} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "bettertoken2",
  tui,
}

export default plugin
