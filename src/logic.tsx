/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal } from "solid-js"
import path from "node:path"
import fs from "node:fs"

// ── Types ──────────────────────────────────────────────────────────────

type Entry = {
  ts: number
  sid: string
  model: string
  provider: string
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
  cost: number
}

type Display = "total" | "output" | "input" | "cache" | "all"
type Period = "today" | "yesterday" | "week" | "month" | "all"

type Budget = {
  enabled: boolean
  daily_tokens: number   // 0 = no limit
  daily_cost: number     // 0 = no limit
  monthly_tokens: number // 0 = no limit
  monthly_cost: number   // 0 = no limit
}

export type Config = {
  display: Display
  show_cost: boolean
  compact: boolean
  footer_periods: Period[]
  budget: Budget
}

type Store = {
  entries: Entry[]
  seen: string[]
}

// ── Constants ──────────────────────────────────────────────────────────

const KV_CFG = "bettertoken.config"
const FILENAME = "bettertoken.json"
const ALL_PERIODS: Period[] = ["today", "yesterday", "week", "month", "all"]
const BACK = { title: "<- Back", value: "back", description: "" }
const EMPTY: Store = { entries: [], seen: [] }
const SPARKS = [" ", "\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"]

const NO_BUDGET: Budget = {
  enabled: false,
  daily_tokens: 0,
  daily_cost: 0,
  monthly_tokens: 0,
  monthly_cost: 0,
}

export const DEFAULTS: Config = {
  display: "total",
  show_cost: true,
  compact: false,
  footer_periods: ["today", "month"],
  budget: NO_BUDGET,
}

// ── Helpers ────────────────────────────────────────────────────────────

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function startOf(period: Period): number {
  const now = new Date()
  if (period === "today") return dayStart(now)
  if (period === "yesterday") {
    const y = new Date(now)
    y.setDate(y.getDate() - 1)
    return dayStart(y)
  }
  if (period === "week") {
    const day = now.getDay()
    const diff = day === 0 ? 6 : day - 1
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff).getTime()
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

function endOf(period: Period): number | undefined {
  if (period === "yesterday") return startOf("today")
  return undefined
}

function tok(e: Entry, mode: Display): number {
  if (mode === "output") return e.output
  if (mode === "input") return e.input
  if (mode === "cache") return e.cache_read + e.cache_write
  if (mode === "all") return e.input + e.output + e.reasoning + e.cache_read + e.cache_write
  return e.input + e.output + e.reasoning + e.cache_write
}

function aggregate(entries: Entry[], mode: Display): number {
  return entries.reduce((s, e) => s + tok(e, mode), 0)
}

function sumCost(entries: Entry[]): number {
  return entries.reduce((s, e) => s + e.cost, 0)
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

function periodLabel(p: string, compact = false): string {
  if (compact) {
    if (p === "today") return "T"
    if (p === "yesterday") return "Y"
    if (p === "week") return "W"
    if (p === "month") return "M"
    return "All"
  }
  if (p === "today") return "Today"
  if (p === "yesterday") return "Yesterday"
  if (p === "week") return "Week"
  if (p === "month") return "Month"
  return "All-time"
}

function periodFilter(entries: Entry[], period: string): Entry[] {
  if (period === "all") return entries
  const cutoff = startOf(period as Period)
  const cap = endOf(period as Period)
  return entries.filter((e) => e.ts >= cutoff && (cap === undefined || e.ts < cap))
}

function displayLabel(d: Display): string {
  if (d === "total") return "Billed (in+out+reason+cache write)"
  if (d === "output") return "Output only"
  if (d === "input") return "Input only"
  if (d === "cache") return "Cache (read+write)"
  return "Everything (incl. cache read)"
}

function formatStats(entries: Entry[], cfg: Config): string {
  const sep = cfg.compact ? "|" : " | "
  return cfg.footer_periods.map((p) => {
    const f = periodFilter(entries, p)
    const t = aggregate(f, cfg.display)
    const co = sumCost(f)
    const lbl = periodLabel(p, cfg.compact)
    let text = cfg.compact ? `${lbl}:${fmt(t)}` : `${lbl}: ${fmt(t)}`
    if (cfg.show_cost && co > 0) text += ` ${money.format(co)}`
    return text
  }).join(sep)
}

// ── Sparkline (last 7 days) ───────────────────────────────────────────

function sparkline(entries: Entry[], mode: Display): string {
  const now = new Date()
  const days: number[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const start = dayStart(d)
    const end = start + 86400000
    const total = entries
      .filter((e) => e.ts >= start && e.ts < end)
      .reduce((s, e) => s + tok(e, mode), 0)
    days.push(total)
  }
  const max = Math.max(...days, 1)
  return days.map((v) => SPARKS[Math.round((v / max) * 8)]).join("")
}

// ── Daily average ─────────────────────────────────────────────────────

function dailyAvg(entries: Entry[], mode: Display): string {
  if (entries.length === 0) return "0"
  const sorted = [...entries].sort((a, b) => a.ts - b.ts)
  const first = dayStart(new Date(sorted[0].ts))
  const last = dayStart(new Date())
  const days = Math.max(1, Math.round((last - first) / 86400000) + 1)
  const total = aggregate(entries, mode)
  return fmt(Math.round(total / days))
}

// ── Top sessions ──────────────────────────────────────────────────────

function topSessions(entries: Entry[], limit: number, mode: Display) {
  const map = new Map<string, { tokens: number; cost: number; count: number }>()
  for (const e of entries) {
    const sid = e.sid || "unknown"
    const cur = map.get(sid) ?? { tokens: 0, cost: 0, count: 0 }
    cur.tokens += tok(e, mode)
    cur.cost += e.cost
    cur.count++
    map.set(sid, cur)
  }
  return [...map.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, limit)
}

// ── Context % ─────────────────────────────────────────────────────────

function contextInfo(api: TuiPluginApi, sid?: string): string {
  if (!sid) {
    const route = api.route.current
    if (route.name !== "session") return ""
    sid = (route as any).params?.sessionID as string | undefined
    if (!sid) return ""
  }
  const msgs = api.state.session.messages(sid)
  const last = msgs.findLast(
    (m): m is AssistantMessage => m.role === "assistant" && m.tokens.output > 0
  )
  if (!last) return ""
  const total = last.tokens.input + last.tokens.output + last.tokens.reasoning
    + last.tokens.cache.read + last.tokens.cache.write
  if (total <= 0) return ""
  const model = api.state.provider
    .find((p) => p.id === last.providerID)
    ?.models[last.modelID]
  if (!model?.limit.context) return fmt(total)
  const pct = Math.round((total / model.limit.context) * 100)
  return `${fmt(total)} (${pct}%)`
}

// ── Cost estimation ───────────────────────────────────────────────────

function estimateCost(api: TuiPluginApi, msg: AssistantMessage): number {
  if (msg.cost > 0) return msg.cost
  const model = api.state.provider
    .find((p) => p.id === msg.providerID)
    ?.models[msg.modelID]
  if (!model?.cost) return 0
  const c = model.cost as { input: number; output: number; cache?: { read: number; write: number } }
  return (
    (msg.tokens.input * (c.input ?? 0)) / 1_000_000 +
    (msg.tokens.output * (c.output ?? 0)) / 1_000_000 +
    (msg.tokens.reasoning * (c.output ?? 0)) / 1_000_000 +
    (msg.tokens.cache.read * (c.cache?.read ?? 0)) / 1_000_000 +
    (msg.tokens.cache.write * (c.cache?.write ?? 0)) / 1_000_000
  )
}

// ── Budget check ──────────────────────────────────────────────────────

type BudgetStatus = { over: boolean; warnings: string[] }

function checkBudget(entries: Entry[], cfg: Config): BudgetStatus {
  const b = cfg.budget
  if (!b.enabled) return { over: false, warnings: [] }
  const warnings: string[] = []
  let over = false

  const todayEntries = periodFilter(entries, "today")
  const monthEntries = periodFilter(entries, "month")
  const todayTok = aggregate(todayEntries, cfg.display)
  const todayCost = sumCost(todayEntries)
  const monthTok = aggregate(monthEntries, cfg.display)
  const monthCost = sumCost(monthEntries)

  if (b.daily_tokens > 0 && todayTok >= b.daily_tokens) {
    over = true
    warnings.push(`Daily tokens: ${fmt(todayTok)}/${fmt(b.daily_tokens)}`)
  }
  if (b.daily_cost > 0 && todayCost >= b.daily_cost) {
    over = true
    warnings.push(`Daily cost: ${money.format(todayCost)}/${money.format(b.daily_cost)}`)
  }
  if (b.monthly_tokens > 0 && monthTok >= b.monthly_tokens) {
    over = true
    warnings.push(`Monthly tokens: ${fmt(monthTok)}/${fmt(b.monthly_tokens)}`)
  }
  if (b.monthly_cost > 0 && monthCost >= b.monthly_cost) {
    over = true
    warnings.push(`Monthly cost: ${money.format(monthCost)}/${money.format(b.monthly_cost)}`)
  }

  return { over, warnings }
}

// ── OSC52 clipboard ───────────────────────────────────────────────────

function copyToClipboard(text: string) {
  const b64 = Buffer.from(text).toString("base64")
  process.stdout.write(`\x1b]52;c;${b64}\x07`)
}

// ── File-based data store ─────────────────────────────────────────────

let dataPath = ""
let cachedStore: Store = EMPTY
let cachedMtime = 0
let writing = false
const MAX_AGE_MS = 90 * 86400000 // 90 days

function resolveDataPath(api: TuiPluginApi): string {
  if (dataPath) return dataPath
  const dir = api.state.path.state
  if (!dir) return ""
  dataPath = path.join(dir, FILENAME)
  return dataPath
}

function readDisk(api: TuiPluginApi): Store {
  const p = resolveDataPath(api)
  if (!p) return EMPTY
  try {
    const stat = fs.statSync(p)
    const mtime = stat.mtimeMs
    // Only re-read if file changed since last read
    if (mtime === cachedMtime && cachedStore !== EMPTY) return cachedStore
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"))
    if (raw && Array.isArray(raw.entries)) {
      cachedStore = { entries: raw.entries, seen: raw.seen ?? [] }
      cachedMtime = mtime
      return cachedStore
    }
  } catch {}
  return EMPTY
}

function writeDisk(api: TuiPluginApi, store: Store) {
  const p = resolveDataPath(api)
  if (!p) return
  // Prune entries older than 90 days
  const cutoff = Date.now() - MAX_AGE_MS
  const pruned = store.entries.filter((e) => e.ts >= cutoff)
  const seenSet = new Set(store.seen)
  // Only keep seen IDs that match remaining entries (cleanup)
  const prunedSeen = pruned.map((e) => e.sid).length > 0
    ? store.seen.filter((id) => seenSet.has(id)).slice(-5000)
    : store.seen.slice(-5000)
  const bounded = { entries: pruned, seen: prunedSeen }
  try {
    fs.writeFileSync(p, JSON.stringify(bounded), "utf-8")
    // Update cache immediately after write
    cachedStore = bounded
    cachedMtime = fs.statSync(p).mtimeMs
  } catch {}
}

export function loadCfg(api: TuiPluginApi, initial: Config): Config {
  const raw = api.kv.get<Partial<Config>>(KV_CFG)
  if (!raw) return initial
  return { ...initial, ...raw }
}

function saveCfg(api: TuiPluginApi, cfg: Config) {
  api.kv.set(KV_CFG, cfg)
}

export function record(api: TuiPluginApi, msg: AssistantMessage) {
  // Force fresh read from disk (bypass mtime cache) to merge with other sessions
  const p = resolveDataPath(api)
  if (!p) return
  let store: Store = EMPTY
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"))
    if (raw && Array.isArray(raw.entries)) store = { entries: raw.entries, seen: raw.seen ?? [] }
  } catch {}
  // Use Set for O(1) dedup check
  const seenSet = new Set(store.seen)
  if (seenSet.has(msg.id)) return
  const entry: Entry = {
    ts: msg.time.completed ?? msg.time.created,
    sid: msg.sessionID,
    model: msg.modelID,
    provider: msg.providerID,
    input: msg.tokens.input,
    output: msg.tokens.output,
    reasoning: msg.tokens.reasoning,
    cache_read: msg.tokens.cache.read,
    cache_write: msg.tokens.cache.write,
    cost: estimateCost(api, msg),
  }
  const next: Store = {
    entries: [...store.entries, entry],
    seen: [...store.seen, msg.id],
  }
  writeDisk(api, next)
}

// ── Dialogs ────────────────────────────────────────────────────────────

export function showMain(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void) {
  const entries = readDisk(api).entries
  const c = cfg()

  // Usage periods
  const lines = ALL_PERIODS.map((p) => {
    const f = periodFilter(entries, p)
    const t = aggregate(f, c.display)
    const co = sumCost(f)
    const desc = co > 0 ? `${fmt(t)} tokens · ${money.format(co)}` : `${fmt(t)} tokens`
    return { title: periodLabel(p), value: `period:${p}`, description: desc, category: "Usage" }
  })

  // Stats
  const avg = dailyAvg(entries, c.display)
  const spark = sparkline(entries, c.display)
  const stats = [
    { title: `Daily avg: ${avg}/day`, value: "noop", description: `Last 7 days: ${spark}`, category: "Stats" },
  ]

  // Models
  const models = new Map<string, { input: number; output: number; cost: number }>()
  for (const e of entries) {
    const key = `${e.provider}/${e.model}`
    const cur = models.get(key) ?? { input: 0, output: 0, cost: 0 }
    cur.input += e.input
    cur.output += e.output
    cur.cost += e.cost
    models.set(key, cur)
  }
  const modelRows = [...models.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([name, d]) => ({
      title: name,
      value: `model:${name}`,
      description: `in: ${fmt(d.input)} · out: ${fmt(d.output)} · ${money.format(d.cost)}`,
      category: "By Model",
    }))

  // Top sessions
  const tops = topSessions(entries, 5, c.display)
  const topRows = tops.map(([sid, d]) => ({
    title: sid.slice(0, 24),
    value: `session:${sid}`,
    description: `${fmt(d.tokens)} tokens · ${money.format(d.cost)} · ${d.count} msgs`,
    category: "Top Sessions",
  }))

  // Settings
  const settings = [
    { title: "Display mode", value: "cfg:display", description: displayLabel(c.display), category: "Settings" },
    { title: "Show cost in footer", value: "cfg:show_cost", description: c.show_cost ? "Yes" : "No", category: "Settings" },
    { title: "Compact mode", value: "cfg:compact", description: c.compact ? "On (T: W: M:)" : "Off (Today: Week: Month:)", category: "Settings" },
    { title: "Footer periods", value: "cfg:periods", description: c.footer_periods.map((p) => periodLabel(p)).join(", "), category: "Settings" },
    { title: "Budget alerts", value: "cfg:budget", description: c.budget.enabled ? budgetSummary(c.budget) : "Off", category: "Settings" },
  ]

  // Actions
  const actions = [
    { title: "Export to clipboard", value: "action:export", description: "Copy full report as text", category: "Actions" },
    { title: "Reset all data", value: "action:reset", description: `${entries.length} entries stored`, category: "Actions" },
    { title: patchInstalled ? "Inline patch installed" : "Install inline patch", value: "action:patch_info", description: patchInstalled ? "Stats show next to TPS" : "Run: bettertoken patch", category: "Actions" },
  ]

  api.ui.dialog.setSize("large")
  setTimeout(() => {
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="BetterToken"
        options={[...lines, ...stats, ...modelRows, ...topRows, ...settings, ...actions]}
        onSelect={(item) => {
          const v = item.value as string
          if (v === "noop") return showMain(api, cfg, setCfg)
          if (v === "cfg:display") return showDisplayPicker(api, cfg, setCfg)
          if (v === "cfg:show_cost") {
            const next = { ...cfg(), show_cost: !cfg().show_cost }
            setCfg(next)
            saveCfg(api, next)
            api.ui.toast({ variant: "success", message: `Show cost: ${next.show_cost ? "Yes" : "No"}` })
            return showMain(api, cfg, setCfg)
          }
          if (v === "cfg:compact") {
            const next = { ...cfg(), compact: !cfg().compact }
            setCfg(next)
            saveCfg(api, next)
            api.ui.toast({ variant: "success", message: next.compact ? "Compact mode on" : "Compact mode off" })
            return showMain(api, cfg, setCfg)
          }
          if (v === "cfg:budget") return showBudgetMenu(api, cfg, setCfg)
          if (v === "cfg:periods") return showPeriodPicker(api, cfg, setCfg)
          if (v === "action:reset") return showResetConfirm(api, cfg, setCfg)
          if (v === "action:export") return doExport(api, cfg)
          if (v === "action:patch_info") {
            const msg = patchInstalled
              ? "Inline patch is installed. Stats appear next to TPS and context %.\n\nTo remove: run 'bettertoken unpatch' in your terminal."
              : "Inline patch is not installed. Stats appear below the footer.\n\nTo install: run 'bettertoken patch' in your terminal.\nThen restart OpenCode."
            api.ui.dialog.replace(() => (
              <api.ui.DialogAlert
                title="BetterToken > Inline Patch"
                message={msg}
                onConfirm={() => showMain(api, cfg, setCfg)}
              />
            ))
            return
          }
          if (v.startsWith("period:")) return showPeriodDetail(api, cfg, setCfg, v.replace("period:", ""))
          api.ui.dialog.clear()
        }}
      />
    ))
  }, 0)
}

function showDisplayPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void) {
  const modes: Display[] = ["total", "output", "input", "cache", "all"]
  const options = modes.map((m) => ({
    title: m.charAt(0).toUpperCase() + m.slice(1),
    value: m,
    description: displayLabel(m),
  }))

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect<Display | "back">
      title="BetterToken > Display Mode"
      options={[BACK as any, ...options]}
      current={cfg().display}
      onSelect={(item) => {
        if (item.value === "back") return showMain(api, cfg, setCfg)
        const next = { ...cfg(), display: item.value as Display }
        setCfg(next)
        saveCfg(api, next)
        api.ui.toast({ variant: "success", message: `Display: ${item.title}` })
        showDisplayPicker(api, cfg, setCfg)
      }}
    />
  ))
}

function showPeriodPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void) {
  const current = cfg().footer_periods
  const options = ALL_PERIODS.map((p) => ({
    title: `${current.includes(p) ? "[x] " : "[ ] "}${periodLabel(p)}`,
    value: p,
    description: current.includes(p) ? "Shown in footer" : "Hidden",
  }))

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect<Period | "back">
      title="BetterToken > Footer Periods"
      options={[BACK as any, ...options]}
      onSelect={(item) => {
        if (item.value === "back") return showMain(api, cfg, setCfg)
        const cur = cfg().footer_periods
        const toggled = cur.includes(item.value as Period)
          ? cur.filter((p) => p !== item.value)
          : [...cur, item.value as Period]
        const next = { ...cfg(), footer_periods: toggled.length > 0 ? toggled : ["today"] }
        setCfg(next)
        saveCfg(api, next)
        showPeriodPicker(api, cfg, setCfg)
      }}
    />
  ))
}

function budgetSummary(b: Budget): string {
  const parts: string[] = []
  if (b.daily_tokens > 0) parts.push(`${fmt(b.daily_tokens)}/day`)
  if (b.daily_cost > 0) parts.push(`${money.format(b.daily_cost)}/day`)
  if (b.monthly_tokens > 0) parts.push(`${fmt(b.monthly_tokens)}/mo`)
  if (b.monthly_cost > 0) parts.push(`${money.format(b.monthly_cost)}/mo`)
  return parts.length > 0 ? parts.join(", ") : "No limits set"
}

function showBudgetMenu(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void) {
  const b = cfg().budget
  const options = [
    BACK,
    { title: "Budget alerts", value: "toggle", description: b.enabled ? "On" : "Off" },
    { title: "Daily token limit", value: "daily_tokens", description: b.daily_tokens > 0 ? fmt(b.daily_tokens) : "No limit" },
    { title: "Daily cost limit", value: "daily_cost", description: b.daily_cost > 0 ? money.format(b.daily_cost) : "No limit" },
    { title: "Monthly token limit", value: "monthly_tokens", description: b.monthly_tokens > 0 ? fmt(b.monthly_tokens) : "No limit" },
    { title: "Monthly cost limit", value: "monthly_cost", description: b.monthly_cost > 0 ? money.format(b.monthly_cost) : "No limit" },
  ]

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="BetterToken > Budget"
      options={options}
      onSelect={(item) => {
        if (item.value === "back") return showMain(api, cfg, setCfg)
        if (item.value === "toggle") {
          const next = { ...cfg(), budget: { ...cfg().budget, enabled: !cfg().budget.enabled } }
          setCfg(next)
          saveCfg(api, next)
          api.ui.toast({ variant: "success", message: next.budget.enabled ? "Budget alerts on" : "Budget alerts off" })
          return showBudgetMenu(api, cfg, setCfg)
        }
        // Prompt for a number
        const field = item.value as keyof Budget
        const isTokens = field.includes("tokens")
        api.ui.dialog.replace(() => (
          <api.ui.DialogPrompt
            title={`BetterToken > Budget > ${item.title}`}
            placeholder={isTokens ? "e.g. 500000 (0 = no limit)" : "e.g. 5.00 (0 = no limit)"}
            value={String(b[field] ?? 0)}
            onConfirm={(val) => {
              const num = parseFloat(val) || 0
              const next = { ...cfg(), budget: { ...cfg().budget, [field]: Math.max(0, num) } }
              setCfg(next)
              saveCfg(api, next)
              api.ui.dialog.clear()
              api.ui.toast({ variant: "success", message: `${item.title}: ${num > 0 ? (isTokens ? fmt(num) : money.format(num)) : "No limit"}` })
              showBudgetMenu(api, cfg, setCfg)
            }}
            onCancel={() => {
              api.ui.dialog.clear()
              showBudgetMenu(api, cfg, setCfg)
            }}
          />
        ))
      }}
    />
  ))
}

function showResetConfirm(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogConfirm
      title="BetterToken > Reset"
      message="This will delete all tracked token entries. This cannot be undone."
      onConfirm={() => {
        writeDisk(api, EMPTY)
        api.ui.toast({ variant: "success", message: "All token data cleared" })
      }}
      onCancel={() => showMain(api, cfg, setCfg)}
    />
  ))
}

function showPeriodDetail(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, period: string) {
  const entries = periodFilter(readDisk(api).entries, period)
  const input = entries.reduce((s, e) => s + e.input, 0)
  const output = entries.reduce((s, e) => s + e.output, 0)
  const reasoning = entries.reduce((s, e) => s + e.reasoning, 0)
  const cread = entries.reduce((s, e) => s + e.cache_read, 0)
  const cwrite = entries.reduce((s, e) => s + e.cache_write, 0)
  const total = sumCost(entries)

  const msg = [
    `Input:         ${fmt(input).padStart(10)}`,
    `Output:        ${fmt(output).padStart(10)}`,
    `Reasoning:     ${fmt(reasoning).padStart(10)}`,
    `Cache read:    ${fmt(cread).padStart(10)}`,
    `Cache write:   ${fmt(cwrite).padStart(10)}`,
    ``,
    `Total cost:    ${money.format(total).padStart(10)}`,
    `Messages:      ${entries.length.toString().padStart(10)}`,
  ].join("\n")

  api.ui.dialog.replace(() => (
    <api.ui.DialogAlert
      title={`BetterToken > ${periodLabel(period)}`}
      message={msg}
      onConfirm={() => showMain(api, cfg, setCfg)}
    />
  ))
}

function doExport(api: TuiPluginApi, cfg: () => Config) {
  const entries = readDisk(api).entries
  const c = cfg()
  const lines: string[] = ["=== BetterToken Report ===", ""]

  for (const p of ALL_PERIODS) {
    const f = periodFilter(entries, p)
    const t = aggregate(f, c.display)
    const co = sumCost(f)
    lines.push(`${periodLabel(p).padEnd(12)} ${fmt(t).padStart(10)} tokens   ${money.format(co).padStart(10)}`)
  }

  lines.push("")
  lines.push(`Daily avg: ${dailyAvg(entries, c.display)}/day`)
  lines.push(`Sparkline (7d): ${sparkline(entries, c.display)}`)
  lines.push("")
  lines.push("--- By Model ---")

  const models = new Map<string, { input: number; output: number; cost: number }>()
  for (const e of entries) {
    const key = `${e.provider}/${e.model}`
    const cur = models.get(key) ?? { input: 0, output: 0, cost: 0 }
    cur.input += e.input
    cur.output += e.output
    cur.cost += e.cost
    models.set(key, cur)
  }
  for (const [name, d] of [...models.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    lines.push(`${name.padEnd(30)} in: ${fmt(d.input).padStart(8)}  out: ${fmt(d.output).padStart(8)}  ${money.format(d.cost).padStart(10)}`)
  }

  lines.push("")
  lines.push("--- Top Sessions ---")
  const tops = topSessions(entries, 10, c.display)
  for (const [sid, d] of tops) {
    lines.push(`${sid.slice(0, 24).padEnd(26)} ${fmt(d.tokens).padStart(8)} tokens  ${money.format(d.cost).padStart(10)}  ${d.count} msgs`)
  }

  lines.push("")
  lines.push(`Total entries: ${entries.length}`)
  lines.push(`Generated: ${new Date().toISOString()}`)

  const report = lines.join("\n")
  copyToClipboard(report)
  api.ui.dialog.clear()
  api.ui.toast({ variant: "success", message: "Report copied to clipboard" })
}

// ── Footer ─────────────────────────────────────────────────────────────

export function FooterView(props: { api: TuiPluginApi; cfg: () => Config; tick: () => number }) {
  const theme = () => props.api.theme.current

  const data = createMemo(() => {
    props.tick()
    const entries = readDisk(props.api).entries
    const c = props.cfg()
    const text = formatStats(entries, c)
    const budget = checkBudget(entries, c)
    return { text, over: budget.over }
  })

  return (
    <text fg={data().over ? "#EF4444" : theme().textMuted} wrapMode="none">
      {data().over ? "! " : ""}{data().text}
    </text>
  )
}

export function InlineView(props: { api: TuiPluginApi; cfg: () => Config; sid: string; tick: () => number }) {
  const data = createMemo(() => {
    props.tick()
    const entries = readDisk(props.api).entries
    const c = props.cfg()
    const ctx = contextInfo(props.api, props.sid)
    const stats = formatStats(entries, c)
    const parts = [ctx, stats].filter(Boolean)
    const budget = checkBudget(entries, c)
    return { text: parts.join(" · "), over: budget.over }
  })

  return <span style={data().over ? { fg: "#EF4444" } : {}}>{" · " + (data().over ? "! " : "") + data().text}</span>
}

// ── Plugin ─────────────────────────────────────────────────────────────

const tui: TuiPlugin = (api, raw) => {
  const initial = { ...DEFAULTS, ...(raw as Partial<Config> | undefined) }
  const [cfg, setCfg] = createSignal<Config>(loadCfg(api, initial))

  // Single shared timer for all footer components
  const [tick, setTick] = createSignal(0)
  const interval = setInterval(() => setTick((t) => t + 1), 2000)
  api.lifecycle.onDispose(() => clearInterval(interval))

  api.event.on("message.updated", (evt) => {
    const msg = evt.properties.info
    if (msg.role !== "assistant") return
    if (!msg.time.completed) return
    if (msg.tokens.output <= 0) return
    record(api, msg as AssistantMessage)
  })

  const dispose = api.command.register(() => [
    {
      title: "BetterToken",
      value: "bettertoken.stats",
      description: "View token usage & settings",
      category: "Plugin",
      slash: { name: "bettertoken" },
      onSelect: () => {
        try {
          showMain(api, cfg, setCfg)
        } catch (e: any) {
          api.ui.toast({ variant: "danger", message: `BetterToken error: ${e?.message ?? e}` })
        }
      },
    },
  ])
  setTimeout(() => api.command.trigger("bettertoken.stats"), 3000)

  // Detect if inline patch is installed by checking if session_usage slot is rendered.
  // We register both slots: session_usage (inline, needs patch) and session_footer (below, native).
  // If the patch is installed, session_usage renders inline and we skip session_footer to avoid doublon.
  // If not patched, session_usage is silently ignored and session_footer shows the stats below.
  // We detect the patch by checking the source file for our slot marker.
  let patchInstalled = false
  try {
    const opencodeDir = path.dirname(path.dirname(api.state.path.state))
    // Try common opencode source locations
    const candidates = [
      path.join(opencodeDir, "opencode-tps-meter", "current", "packages", "opencode", "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx"),
    ]
    // Also check bun's main module location
    if (typeof process !== "undefined" && process.argv[1]) {
      const srcRoot = path.resolve(path.dirname(process.argv[1]), "..")
      candidates.push(path.join(srcRoot, "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx"))
    }
    for (const candidate of candidates) {
      try {
        const src = fs.readFileSync(candidate, "utf-8")
        if (src.includes('name="session_usage"')) { patchInstalled = true; break }
      } catch {}
    }
  } catch {}

  api.slots.register({
    order: 50,
    slots: {
      sidebar_footer() {
        return <FooterView api={api} cfg={cfg} tick={tick} />
      },
      session_footer() {
        // Only show session_footer if patch is NOT installed (fallback mode)
        if (patchInstalled) return null
        return <FooterView api={api} cfg={cfg} tick={tick} />
      },
      session_usage(_ctx: any, props: any) {
        // Only active if patch is installed (inline mode)
        return <InlineView api={api} cfg={cfg} sid={props.session_id} tick={tick} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "bettertoken",
  tui,
}

export default plugin
