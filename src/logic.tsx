/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createMemo } from "solid-js"
import path from "node:path"
import fs from "node:fs"

// ── Types ──────────────────────────────────────────────────────────────

type Entry = {
  ts: number; sid: string; model: string; provider: string
  input: number; output: number; reasoning: number
  cache_read: number; cache_write: number; cost: number
}

type Display = "total" | "output" | "input" | "cache" | "all"
type Period = "today" | "yesterday" | "week" | "month" | "all"

type Budget = {
  enabled: boolean; daily_tokens: number; daily_cost: number
  monthly_tokens: number; monthly_cost: number
}

type Placement = "inline" | "footer" | "sidebar"

export type Config = {
  display: Display; show_cost: boolean; compact: boolean
  footer_periods: Period[]; budget: Budget; placement: Placement
}

type Store = { entries: Entry[]; seen: string[]; titles?: Record<string, string> }

// ── Constants ──────────────────────────────────────────────────────────

const KV_CFG = "bettertoken.config"
const FILENAME = "bettertoken.json"
const ALL_PERIODS: Period[] = ["today", "yesterday", "week", "month", "all"]
const EMPTY: Store = { entries: [], seen: [] }
const SPARKS = [" ", "\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"]

const NO_BUDGET: Budget = { enabled: false, daily_tokens: 0, daily_cost: 0, monthly_tokens: 0, monthly_cost: 0 }

export const DEFAULTS: Config = {
  display: "total", show_cost: true, compact: false,
  footer_periods: ["today", "month"], budget: NO_BUDGET, placement: "inline",
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })

// ── Helpers ────────────────────────────────────────────────────────────

function dayStart(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

function startOf(p: Period): number {
  const now = new Date()
  if (p === "today") return dayStart(now)
  if (p === "yesterday") { const y = new Date(now); y.setDate(y.getDate() - 1); return dayStart(y) }
  if (p === "week") { const day = now.getDay(); return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day === 0 ? 6 : day - 1)).getTime() }
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

function endOf(p: Period): number | undefined { return p === "yesterday" ? startOf("today") : undefined }

function tok(e: Entry, m: Display): number {
  if (m === "output") return e.output
  if (m === "input") return e.input
  if (m === "cache") return e.cache_read + e.cache_write
  if (m === "all") return e.input + e.output + e.reasoning + e.cache_read + e.cache_write
  return e.input + e.output + e.reasoning + e.cache_write
}

function agg(entries: Entry[], m: Display) { return entries.reduce((s, e) => s + tok(e, m), 0) }
function sumC(entries: Entry[]) { return entries.reduce((s, e) => s + e.cost, 0) }

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

function periodLabel(p: string, compact = false): string {
  const labels: any = compact
    ? { today: "T", yesterday: "Y", week: "W", month: "M", all: "All" }
    : { today: "Today", yesterday: "Yesterday", week: "Week", month: "Month", all: "All-time" }
  return labels[p] || p
}

function periodFilter(entries: Entry[], p: string): Entry[] {
  if (p === "all") return entries
  const cutoff = startOf(p as Period), cap = endOf(p as Period)
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
    const f = periodFilter(entries, p), t = agg(f, cfg.display), co = sumC(f)
    const lbl = periodLabel(p, cfg.compact)
    let text = cfg.compact ? `${lbl}:${fmt(t)}` : `${lbl}: ${fmt(t)}`
    if (cfg.show_cost && co > 0) text += ` ${money.format(co)}`
    return text
  }).join(sep)
}

function sparkline(entries: Entry[], mode: Display): string {
  const now = new Date(), days: number[] = []
  for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); const s = dayStart(d); days.push(entries.filter((e) => e.ts >= s && e.ts < s + 864e5).reduce((a, e) => a + tok(e, mode), 0)) }
  const mx = Math.max(...days, 1)
  return days.map((v) => SPARKS[Math.round((v / mx) * 8)]).join("")
}

function dailyAvg(entries: Entry[], mode: Display): string {
  if (!entries.length) return "0"
  const sorted = [...entries].sort((a, b) => a.ts - b.ts)
  const days = Math.max(1, Math.round((dayStart(new Date()) - dayStart(new Date(sorted[0].ts))) / 864e5) + 1)
  return fmt(Math.round(agg(entries, mode) / days))
}

function topSessions(entries: Entry[], limit: number, mode: Display) {
  const map = new Map<string, { tokens: number; cost: number; count: number }>()
  for (const e of entries) {
    const sid = e.sid || "unknown", cur = map.get(sid) ?? { tokens: 0, cost: 0, count: 0 }
    cur.tokens += tok(e, mode); cur.cost += e.cost; cur.count++; map.set(sid, cur)
  }
  return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, limit)
}

// ── Context % ─────────────────────────────────────────────────────────

function contextInfo(api: TuiPluginApi, sid?: string): string {
  try {
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
    const providers = api.state.provider
    if (!providers) return fmt(total)
    const model = providers.find((p) => p.id === last.providerID)?.models[last.modelID]
    if (!model?.limit?.context) return fmt(total)
    const pct = Math.round((total / model.limit.context) * 100)
    return `${fmt(total)} (${pct}%)`
  } catch {
    return ""
  }
}

// ── Cost estimation ───────────────────────────────────────────────────

function estimateCost(api: TuiPluginApi, msg: AssistantMessage): number {
  if (msg.cost > 0) return msg.cost
  const model = api.state.provider.find((p) => p.id === msg.providerID)?.models[msg.modelID]
  if (!model?.cost) return 0
  const c = model.cost as { input: number; output: number; cache?: { read: number; write: number } }
  return (
    (msg.tokens.input * (c.input ?? 0)) / 1e6 +
    (msg.tokens.output * (c.output ?? 0)) / 1e6 +
    (msg.tokens.reasoning * (c.output ?? 0)) / 1e6 +
    (msg.tokens.cache.read * (c.cache?.read ?? 0)) / 1e6 +
    (msg.tokens.cache.write * (c.cache?.write ?? 0)) / 1e6
  )
}

// ── Budget check ──────────────────────────────────────────────────────

function checkBudget(entries: Entry[], cfg: Config): { over: boolean; warnings: string[] } {
  const b = cfg.budget
  if (!b.enabled) return { over: false, warnings: [] }
  const warnings: string[] = []
  let over = false
  const td = periodFilter(entries, "today"), md = periodFilter(entries, "month")
  if (b.daily_tokens > 0 && agg(td, cfg.display) >= b.daily_tokens) { over = true; warnings.push(`Daily tokens: ${fmt(agg(td, cfg.display))}/${fmt(b.daily_tokens)}`) }
  if (b.daily_cost > 0 && sumC(td) >= b.daily_cost) { over = true; warnings.push(`Daily cost: ${money.format(sumC(td))}/${money.format(b.daily_cost)}`) }
  if (b.monthly_tokens > 0 && agg(md, cfg.display) >= b.monthly_tokens) { over = true; warnings.push(`Monthly tokens: ${fmt(agg(md, cfg.display))}/${fmt(b.monthly_tokens)}`) }
  if (b.monthly_cost > 0 && sumC(md) >= b.monthly_cost) { over = true; warnings.push(`Monthly cost: ${money.format(sumC(md))}/${money.format(b.monthly_cost)}`) }
  return { over, warnings }
}

// ── File store ────────────────────────────────────────────────────────

let dataPath = ""
let cachedStore: Store = EMPTY
let cachedMtime = 0
const MAX_AGE_MS = 90 * 864e5

function resolvePath(api: TuiPluginApi): string {
  if (dataPath) return dataPath
  const dir = api.state.path.state
  if (!dir) return ""
  dataPath = path.join(dir, FILENAME)
  return dataPath
}

function readDisk(api: TuiPluginApi): Store {
  const p = resolvePath(api)
  if (!p) return EMPTY
  try {
    const stat = fs.statSync(p)
    if (stat.mtimeMs === cachedMtime && cachedStore !== EMPTY) return cachedStore
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"))
    if (raw && Array.isArray(raw.entries)) { cachedStore = { entries: raw.entries, seen: raw.seen ?? [], titles: raw.titles ?? {} }; cachedMtime = stat.mtimeMs; return cachedStore }
  } catch {}
  return EMPTY
}

function writeDisk(api: TuiPluginApi, store: Store) {
  const p = resolvePath(api)
  if (!p) return
  const cutoff = Date.now() - MAX_AGE_MS
  const pruned = store.entries.filter((e) => e.ts >= cutoff)
  const bounded: Store = { entries: pruned, seen: store.seen.slice(-5000), titles: store.titles || {} }
  try { fs.writeFileSync(p, JSON.stringify(bounded), "utf-8"); cachedStore = bounded; cachedMtime = fs.statSync(p).mtimeMs } catch {}
}

export function loadCfg(api: TuiPluginApi, initial: Config): Config {
  const raw = api.kv.get<Partial<Config>>(KV_CFG)
  if (!raw) return initial
  return { ...initial, ...raw }
}

function saveCfg(api: TuiPluginApi, cfg: Config) { api.kv.set(KV_CFG, cfg) }

// Title cache - populated by sidebar_title slot and async lookups
const titleCache = new Map<string, string>()

export function cacheTitle(sid: string, title: string) {
  if (sid && title) titleCache.set(sid, title)
}

export function record(api: TuiPluginApi, msg: AssistantMessage) {
  const p = resolvePath(api)
  if (!p) return
  let store: Store = EMPTY
  try { const raw = JSON.parse(fs.readFileSync(p, "utf-8")); if (raw?.entries) store = { entries: raw.entries, seen: raw.seen ?? [], titles: raw.titles ?? {} } } catch {}
  if (new Set(store.seen).has(msg.id)) return
  const entry: Entry = {
    ts: msg.time.completed ?? msg.time.created, sid: msg.sessionID,
    model: msg.modelID, provider: msg.providerID,
    input: msg.tokens.input, output: msg.tokens.output, reasoning: msg.tokens.reasoning,
    cache_read: msg.tokens.cache.read, cache_write: msg.tokens.cache.write,
    cost: estimateCost(api, msg),
  }
  // Save cached titles to disk
  const titles = { ...(store.titles || {}) }
  for (const [sid, t] of titleCache) { if (!titles[sid]) titles[sid] = t }
  writeDisk(api, { entries: [...store.entries, entry], seen: [...store.seen, msg.id], titles })
}

// ── Title refresh ─────────────────────────────────────────────────────

export async function refreshTitles(api: TuiPluginApi) {
  try {
    const store = readDisk(api)
    const titles = { ...(store.titles || {}) }

    // Load disk cache into memory
    for (const [sid, t] of Object.entries(titles)) { titleCache.set(sid, t) }

    // Fetch all sessions from client
    const res = await api.client.session.list() as any
    const sessions = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
    let changed = false
    for (const s of sessions) {
      if (s.id && s.title && !titles[s.id]) {
        titles[s.id] = s.title
        titleCache.set(s.id, s.title)
        changed = true
      }
    }
    if (changed) writeDisk(api, { ...store, titles })
  } catch {}
}

// ── Dialogs ────────────────────────────────────────────────────────────

export function showMain(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  function buildOptions() {
    const store = readDisk(api)
    const entries = store.entries
    const diskTitles = store.titles || {}
    const c = cfg()
    if (tick) tick() // subscribe to reactive tick for live updates

    // Usage: all periods + daily avg
    const lines = ALL_PERIODS.map((p) => {
      const f = periodFilter(entries, p), t = agg(f, c.display), co = sumC(f)
      const costStr = co > 0 ? ` · ${money.format(co)}` : ""
      return { title: periodLabel(p), value: `period:${p}`, description: `${fmt(t)}${costStr}`, category: "Usage" }
    })
    lines.push({ title: `Daily avg: ${dailyAvg(entries, c.display)}/day`, value: "noop", description: sparkline(entries, c.display), category: "Usage" })

    // Models: top 3
    const models = new Map<string, { total: number; cost: number; count: number }>()
    for (const e of entries) {
      const k = e.model || "unknown"
      const cur = models.get(k) ?? { total: 0, cost: 0, count: 0 }
      cur.total += tok(e, c.display); cur.cost += e.cost; cur.count++
      models.set(k, cur)
    }
    const modelRows = [...models.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 3).map(([name, d]) => ({
      title: name, value: `model:${name}`, description: `${fmt(d.total)} · ${d.count} msgs`, category: "Models",
    }))

    // Sessions
    const sesMap = new Map<string, { tokens: number; cost: number; count: number; lastTs: number }>()
    for (const e of entries) {
      const sid = e.sid || "unknown"
      const cur = sesMap.get(sid) ?? { tokens: 0, cost: 0, count: 0, lastTs: 0 }
      cur.tokens += tok(e, c.display); cur.cost += e.cost; cur.count++
      if (e.ts > cur.lastTs) cur.lastTs = e.ts
      sesMap.set(sid, cur)
    }
    const allSessions = [...sesMap.entries()].filter(([sid]) => sid && sid !== "unknown" && sid !== "")

    function sesTitle(sid: string) {
      let title = titleCache.get(sid) || diskTitles[sid] || sid.slice(0, 20)
      if (title.length > 36) title = title.slice(0, 33) + "..."
      return title
    }

    function sesRow(sid: string, d: any, cat: string) {
      return { title: sesTitle(sid), value: `session:${sid}`, description: `${fmt(d.tokens)} · ${d.count} msgs`, category: cat }
    }

    const recentRows = [...allSessions].sort((a, b) => b[1].lastTs - a[1].lastTs).slice(0, 3).map(([sid, d]) => sesRow(sid, d, "Recent"))
    const recentSids = new Set(recentRows.map(r => r.value.replace("session:", "")))
    const topRows = [...allSessions].sort((a, b) => b[1].tokens - a[1].tokens).filter(([sid]) => !recentSids.has(sid)).slice(0, 3).map(([sid, d]) => sesRow(sid, d, "Top"))

    const placementLabel = { inline: "Inline", footer: "Footer", sidebar: "Sidebar" }[c.placement] || c.placement
    const settings = [
      { title: "Display mode", value: "cfg:display", description: displayLabel(c.display), category: "Settings" },
      { title: "Show cost in footer", value: "cfg:show_cost", description: c.show_cost ? "On" : "Off", category: "Settings" },
      { title: "Compact mode", value: "cfg:compact", description: c.compact ? "On" : "Off", category: "Settings" },
      { title: "Placement", value: "cfg:placement", description: placementLabel, category: "Settings" },
      { title: "Periods", value: "cfg:periods", description: c.footer_periods.map((p) => periodLabel(p)).join(", "), category: "Settings" },
      { title: "Budget alerts", value: "cfg:budget_menu", description: c.budget.enabled ? "On" : "Off", category: "Settings" },
      { title: "Export report", value: "action:export", description: "", category: "Actions" },
      { title: `Reset data (${entries.length})`, value: "action:reset", description: "", category: "Actions" },
    ]

    return [...lines, ...modelRows, ...recentRows, ...topRows, ...settings]
  }

  // Refresh titles in background each time dashboard opens
  refreshTitles(api).catch(() => {})

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="BetterToken"
      options={buildOptions()}
      onSelect={(item: any) => {
        const v = item.value as string
        if (v === "noop") return showMain(api, cfg, setCfg, tick)
        if (v === "cfg:display") return showDisplayPicker(api, cfg, setCfg, tick)
        if (v === "cfg:show_cost") { const n = { ...cfg(), show_cost: !cfg().show_cost }; setCfg(n); saveCfg(api, n); return showMain(api, cfg, setCfg, tick) }
        if (v === "cfg:compact") { const n = { ...cfg(), compact: !cfg().compact }; setCfg(n); saveCfg(api, n); return showMain(api, cfg, setCfg, tick) }
        if (v === "cfg:periods") return showPeriodPicker(api, cfg, setCfg, tick)
        if (v === "cfg:budget_menu") return showBudgetMenu(api, cfg, setCfg, tick)
        if (v === "cfg:placement") return showPlacementPicker(api, cfg, setCfg, tick)
        if (v === "action:reset") return showResetConfirm(api, cfg, setCfg, tick)
        if (v === "action:export") return doExport(api, cfg)

        showMain(api, cfg, setCfg, tick)
      }}
    />
  ))
}

function showDisplayPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  const modes: Display[] = ["total", "output", "input", "cache", "all"]
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Display Mode"
      options={[
        ...modes.map((m) => ({ title: `${m === cfg().display ? "[x]" : "[ ]"} ${displayLabel(m)}`, value: m })),
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        const n = { ...cfg(), display: item.value as Display }; setCfg(n); saveCfg(api, n); showMain(api, cfg, setCfg, tick)
      }}
    />
  ))
}

function showPeriodPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Footer Periods"
      options={[
        ...ALL_PERIODS.map((p) => ({ title: `${cfg().footer_periods.includes(p) ? "[x]" : "[ ]"} ${periodLabel(p)}`, value: p })),
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        const c = cfg(), p = item.value as Period
        const periods = c.footer_periods.includes(p) ? c.footer_periods.filter((x) => x !== p) : [...c.footer_periods, p]
        const n = { ...c, footer_periods: periods }; setCfg(n); saveCfg(api, n); showPeriodPicker(api, cfg, setCfg, tick)
      }}
    />
  ))
}

function showPlacementPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  const placements: Placement[] = ["inline", "footer", "sidebar"]
  const labels: Record<Placement, string> = { inline: "Inline (next to TPS · context)", footer: "Footer (line below TPS)", sidebar: "Sidebar only" }
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Placement"
      options={[
        ...placements.map((p) => ({ title: `${p === cfg().placement ? "[x]" : "[ ]"} ${labels[p]}`, value: p })),
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        const n = { ...cfg(), placement: item.value as Placement }; setCfg(n); saveCfg(api, n); api.ui.toast({ variant: "success", message: `Placement: ${labels[item.value as Placement]}` }); showMain(api, cfg, setCfg, tick)
      }}
    />
  ))
}

function showBudgetMenu(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  const c = cfg()
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Budget Alerts"
      options={[
        { title: `Alerts: ${c.budget.enabled ? "On" : "Off"}`, value: "toggle" },
        { title: `Daily tokens: ${c.budget.daily_tokens ? fmt(c.budget.daily_tokens) : "Off"}`, value: "daily_tokens" },
        { title: `Daily cost: ${c.budget.daily_cost ? money.format(c.budget.daily_cost) : "Off"}`, value: "daily_cost" },
        { title: `Monthly tokens: ${c.budget.monthly_tokens ? fmt(c.budget.monthly_tokens) : "Off"}`, value: "monthly_tokens" },
        { title: `Monthly cost: ${c.budget.monthly_cost ? money.format(c.budget.monthly_cost) : "Off"}`, value: "monthly_cost" },
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        if (item.value === "toggle") { const n = { ...cfg(), budget: { ...cfg().budget, enabled: !cfg().budget.enabled } }; setCfg(n); saveCfg(api, n); return showBudgetMenu(api, cfg, setCfg, tick) }
        promptBudget(api, cfg, setCfg, item.value, tick)
      }}
    />
  ))
}

function promptBudget(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, field: string, tick?: () => number) {
  const current = String((cfg().budget as any)[field] || 0)
  api.ui.dialog.replace(() => (
    <api.ui.DialogPrompt
      title={field.replace(/_/g, " ")}
      value={current}
      placeholder="0 = disabled"
      onConfirm={(val: string) => { const n = { ...cfg(), budget: { ...cfg().budget, [field]: parseFloat(val) || 0 } }; setCfg(n); saveCfg(api, n); showBudgetMenu(api, cfg, setCfg, tick) }}
      onCancel={() => showBudgetMenu(api, cfg, setCfg, tick)}
    />
  ))
}

function showResetConfirm(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogConfirm
      title="Reset all data?"
      message="This will delete all token tracking data."
      onConfirm={() => { writeDisk(api, EMPTY); api.ui.toast({ variant: "success", message: "Data reset" }); api.ui.dialog.clear() }}
      onCancel={() => showMain(api, cfg, setCfg, tick)}
    />
  ))
}

function doExport(api: TuiPluginApi, cfg: () => Config) {
  const entries = readDisk(api).entries, c = cfg()
  const lines = ["=== BetterToken Report ===", ""]
  for (const p of ALL_PERIODS) { const f = periodFilter(entries, p); lines.push(`${periodLabel(p)}: ${fmt(agg(f, c.display))} tokens · ${money.format(sumC(f))}`) }
  lines.push("", `Daily avg: ${dailyAvg(entries, c.display)}/day`, `Sparkline: ${sparkline(entries, c.display)}`, "", `Total entries: ${entries.length}`, `Generated: ${new Date().toISOString()}`)
  const b64 = Buffer.from(lines.join("\n")).toString("base64")
  process.stdout.write(`\x1b]52;c;${b64}\x07`)
  api.ui.dialog.clear()
  api.ui.toast({ variant: "success", message: "Report copied to clipboard" })
}

// ── Views ──────────────────────────────────────────────────────────────

export function FooterView(props: { api: TuiPluginApi; cfg: () => Config; tick: () => number }) {
  const theme = () => props.api.theme.current
  const data = createMemo(() => {
    props.tick()
    const entries = readDisk(props.api).entries, c = props.cfg()
    return { text: formatStats(entries, c), over: checkBudget(entries, c).over }
  })
  return <text fg={data().over ? "#EF4444" : theme().textMuted} wrapMode="none">{data().over ? "! " : ""}{data().text}</text>
}

export function InlineView(props: { api: TuiPluginApi; cfg: () => Config; sid: string; tick: () => number }) {
  const data = createMemo(() => {
    props.tick()
    const entries = readDisk(props.api).entries, c = props.cfg()
    const ctx = contextInfo(props.api, props.sid)
    const stats = formatStats(entries, c)
    const parts = [ctx, stats].filter(Boolean)
    return { text: parts.join(" · "), over: checkBudget(entries, c).over }
  })
  return <span style={data().over ? { fg: "#EF4444" } : {}}>{" · " + (data().over ? "! " : "") + data().text}</span>
}
