/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = (api) => {
  api.command.register(() => [
    {
      title: "BetterToken",
      value: "bettertoken.menu",
      category: "Plugin",
      onSelect: () => {
        api.ui.dialog.replace(() => (
          <api.ui.DialogAlert
            title="BetterToken"
            message="Minimal test"
            onConfirm={() => api.ui.dialog.clear()}
          />
        ))
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: "bettertoken2",
  tui,
}

export default plugin
