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

type Period = "today" | "yesterday" | "week" | "month" | "all"
type TokenMode = "estimate" | "api_billed" | "output_only" | "custom"
type ProviderKey = "claude" | "openai" | "gemini" | "glm" | "kimi" | "minimax" | "codex" | "deepseek" | "qwen" | "mistral" | "grok" | "local" | "other"

type TokenFlags = {
  input: boolean
  output: boolean
  reasoning: boolean
  cache_read: boolean
  cache_write: boolean
}

type TokenPolicy = {
  global: TokenMode
  providers: Partial<Record<ProviderKey, TokenMode>>
  custom: TokenFlags
}

type Budget = {
  enabled: boolean; daily_tokens: number; daily_cost: number
  monthly_tokens: number; monthly_cost: number
}

export type Config = {
  show_cost: boolean; compact: boolean
  footer_periods: Period[]; prompt_periods: Period[]; prompt_compact: boolean
  token: TokenPolicy; show_separate: boolean; show_cache: boolean; show_reasoning: boolean
  budget: Budget
}

type Store = { entries: Entry[]; seen: string[]; titles?: Record<string, string> }

// ── Constants ──────────────────────────────────────────────────────────

const KV_CFG = "bettertoken.config"
const FILENAME = "bettertoken.json"
const ALL_PERIODS: Period[] = ["today", "yesterday", "week", "month", "all"]
const EMPTY: Store = { entries: [], seen: [] }
const SPARKS = [" ", "\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"]

const NO_BUDGET: Budget = { enabled: false, daily_tokens: 0, daily_cost: 0, monthly_tokens: 0, monthly_cost: 0 }

const NO_CUSTOM: TokenFlags = { input: true, output: true, reasoning: true, cache_read: false, cache_write: false }

const DEFAULT_PROVIDER_PRESETS: Partial<Record<ProviderKey, TokenMode>> = {
  claude: "estimate",
  openai: "api_billed",
  gemini: "api_billed",
  glm: "estimate",
  kimi: "api_billed",
  minimax: "api_billed",
  codex: "api_billed",
  deepseek: "api_billed",
  qwen: "estimate",
  mistral: "estimate",
  grok: "estimate",
  local: "estimate",
}

export const DEFAULTS: Config = {
  show_cost: false, compact: false,
  footer_periods: ["today", "month"], prompt_periods: ["today"], prompt_compact: true,
  token: { global: "estimate", providers: { ...DEFAULT_PROVIDER_PRESETS }, custom: { ...NO_CUSTOM } },
  show_separate: true, show_cache: false, show_reasoning: false,
  budget: NO_BUDGET,
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

const TOKEN_PRESETS: Record<Exclude<TokenMode, "custom">, TokenFlags> = {
  estimate: { input: true, output: true, reasoning: true, cache_read: false, cache_write: false },
  api_billed: { input: true, output: true, reasoning: true, cache_read: true, cache_write: true },
  output_only: { input: false, output: true, reasoning: false, cache_read: false, cache_write: false },
}

function mergeTokenPolicy(raw?: Partial<TokenPolicy>): TokenPolicy {
  const providers: Partial<Record<ProviderKey, TokenMode>> = {}
  for (const [key, value] of Object.entries(raw?.providers ?? {}) as Array<[ProviderKey, unknown]>) {
    const mode = migrateLegacyTokenMode(value)
    if (mode) providers[key] = mode
  }
  return {
    global: migrateLegacyTokenMode(raw?.global) ?? DEFAULTS.token.global,
    providers: { ...DEFAULTS.token.providers, ...providers },
    custom: { ...NO_CUSTOM, ...(raw?.custom ?? {}) },
  }
}

function tokenFlagsForMode(mode: TokenMode, custom: TokenFlags): TokenFlags {
  if (mode === "custom") return custom
  return TOKEN_PRESETS[mode]
}

type ProviderPresetInfo = {
  label: string
  note: string
  source: string
}

const PROVIDER_PRESET_INFO: Record<ProviderKey, ProviderPresetInfo> = {
  claude: {
    label: "Claude",
    note: "Estimate by default; Anthropic caching is billed separately on API.",
    source: "Anthropic prompt caching docs",
  },
  openai: {
    label: "OpenAI",
    note: "API billed including cached input.",
    source: "OpenAI pricing docs",
  },
  gemini: {
    label: "Gemini",
    note: "API billed including cached input and reasoning output.",
    source: "Google Cloud Vertex AI pricing",
  },
  glm: {
    label: "GLM",
    note: "Conservative estimate; cache billing not locked in here.",
    source: "Z.AI GLM docs",
  },
  kimi: {
    label: "Kimi",
    note: "API billed including cached input.",
    source: "Moonshot/Kimi pricing docs",
  },
  minimax: {
    label: "MiniMax",
    note: "API billed including cache read/write.",
    source: "MiniMax paygo docs",
  },
  codex: {
    label: "Codex",
    note: "API billed including cached input.",
    source: "OpenAI pricing docs",
  },
  deepseek: {
    label: "DeepSeek",
    note: "API billed including cache hit/miss.",
    source: "DeepSeek API docs",
  },
  qwen: {
    label: "Qwen",
    note: "Conservative estimate until billing docs are pinned down.",
    source: "Needs verified pricing source",
  },
  mistral: {
    label: "Mistral",
    note: "Conservative estimate until billing docs are pinned down.",
    source: "Needs verified pricing source",
  },
  grok: {
    label: "Grok",
    note: "Conservative estimate until billing docs are pinned down.",
    source: "Needs verified pricing source",
  },
  local: {
    label: "Local",
    note: "Estimate only; no billing semantics assumed.",
    source: "Local/unknown",
  },
  other: {
    label: "Other",
    note: "Falls back to the global mode.",
    source: "Fallback",
  },
}

function normalizeProviderKey(provider: string, model: string): ProviderKey {
  const s = `${provider} ${model}`.toLowerCase()
  if (s.includes("claude") || s.includes("anthropic")) return "claude"
  if (s.includes("codex")) return "codex"
  if (s.includes("gpt") || s.includes("openai") || s.includes("o1") || s.includes("o3")) return "openai"
  if (s.includes("gemini") || s.includes("google")) return "gemini"
  if (s.includes("glm")) return "glm"
  if (s.includes("kimi") || s.includes("moonshot")) return "kimi"
  if (s.includes("minimax")) return "minimax"
  if (s.includes("deepseek")) return "deepseek"
  if (s.includes("qwen")) return "qwen"
  if (s.includes("mistral")) return "mistral"
  if (s.includes("grok") || s.includes("xai")) return "grok"
  if (s.includes("local") || s.includes("ollama") || s.includes("llama")) return "local"
  return "other"
}

function resolveTokenMode(entry: Entry, cfg: Config): TokenMode {
  const key = normalizeProviderKey(entry.provider, entry.model)
  return cfg.token.providers[key] ?? cfg.token.global
}

function resolveTokenFlags(entry: Entry, cfg: Config): TokenFlags {
  return tokenFlagsForMode(resolveTokenMode(entry, cfg), cfg.token.custom)
}

function migrateLegacyTokenMode(mode: unknown): TokenMode | undefined {
  switch (mode) {
    case "estimate":
    case "api_billed":
    case "output_only":
    case "custom":
      return mode as TokenMode
    case "claude_pro": return "estimate"
    case "api_claude": return "api_billed"
    case "api_openai": return "api_billed"
    case "billed": return "api_billed"
    case "balanced": return "estimate"
    case "subscription": return "estimate"
    case "api_basic": return "api_billed"
    case "api_full": return "api_billed"
    default: return undefined
  }
}

// Calculate tokens for a single entry based on the resolved flags
function calcTokens(e: Entry, flags: TokenFlags): { input: number; output: number; reasoning: number; cache: number; total: number } {
  const input = flags.input ? e.input : 0
  const output = flags.output ? e.output : 0
  const reasoning = flags.reasoning ? e.reasoning : 0
  const cacheRead = flags.cache_read ? e.cache_read : 0
  const cacheWrite = flags.cache_write ? e.cache_write : 0
  const cache = cacheRead + cacheWrite
  const total = input + output + reasoning + cache
  return { input, output, reasoning, cache, total }
}

function aggByMode(entries: Entry[], cfg: Config) { 
  return entries.reduce((s, e) => s + calcTokens(e, resolveTokenFlags(e, cfg)).total, 0) 
}

function aggSeparate(entries: Entry[], cfg: Config) {
  return entries.reduce((acc, e) => {
    const t = calcTokens(e, resolveTokenFlags(e, cfg))
    return {
      input: acc.input + t.input,
      output: acc.output + t.output,
      reasoning: acc.reasoning + t.reasoning,
      cache: acc.cache + t.cache,
      total: acc.total + t.total
    }
  }, { input: 0, output: 0, reasoning: 0, cache: 0, total: 0 })
}

function sumC(entries: Entry[]) { return entries.reduce((s, e) => s + e.cost, 0) }

function tokenModeLabel(mode: TokenMode): string {
  switch (mode) {
    case "estimate": return "Estimate (input + output + reasoning, cache off)"
    case "api_billed": return "API billed (input + output + reasoning + cache)"
    case "output_only": return "Output only"
    case "custom": return "Custom"
  }
}

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

function formatStats(entries: Entry[], cfg: Config, periods: Period[], isCompact: boolean): string {
  const sep = isCompact ? "|" : " | "
  return periods.map((p) => {
    const f = periodFilter(entries, p)
    const tokens = aggSeparate(f, cfg)
    const co = sumC(f)
    const lbl = periodLabel(p, isCompact)
    let text = `${lbl}: `
    if (cfg.show_separate) {
      // Show input/output/cache separately
      const parts: string[] = []
      parts.push(`↑${fmt(tokens.input)}`)
      parts.push(`↓${fmt(tokens.output)}`)
      if (cfg.show_reasoning && tokens.reasoning > 0) parts.push(`r${fmt(tokens.reasoning)}`)
      if (cfg.show_cache && tokens.cache > 0) parts.push(`📦${fmt(tokens.cache)}`)
      text += parts.join(isCompact ? " " : " ")
    } else {
      // Show total only
      text += fmt(tokens.total)
    }
    
    if (cfg.show_cost && co > 0) text += ` ${money.format(co)}`
    return text
  }).join(sep)
}

function sparkline(entries: Entry[], cfg: Config): string {
  const now = new Date(), days: number[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const s = dayStart(d)
    days.push(entries.filter((e) => e.ts >= s && e.ts < s + 864e5).reduce((a, e) => a + calcTokens(e, resolveTokenFlags(e, cfg)).total, 0))
  }
  const mx = Math.max(...days, 1)
  return days.map((v) => SPARKS[Math.round((v / mx) * 8)]).join("")
}

function dailyAvg(entries: Entry[], cfg: Config): string {
  if (!entries.length) return "0"
  const sorted = [...entries].sort((a, b) => a.ts - b.ts)
  const days = Math.max(1, Math.round((dayStart(new Date()) - dayStart(new Date(sorted[0].ts))) / 864e5) + 1)
  return fmt(Math.round(aggByMode(entries, cfg) / days))
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
  const dailyTokens = aggByMode(td, cfg)
  const monthlyTokens = aggByMode(md, cfg)
  
  if (b.daily_tokens > 0 && dailyTokens >= b.daily_tokens) { 
    over = true; warnings.push(`Daily tokens: ${fmt(dailyTokens)}/${fmt(b.daily_tokens)}`) 
  }
  if (b.daily_cost > 0 && sumC(td) >= b.daily_cost) { 
    over = true; warnings.push(`Daily cost: ${money.format(sumC(td))}/${money.format(b.daily_cost)}`) 
  }
  if (b.monthly_tokens > 0 && monthlyTokens >= b.monthly_tokens) { 
    over = true; warnings.push(`Monthly tokens: ${fmt(monthlyTokens)}/${fmt(b.monthly_tokens)}`) 
  }
  if (b.monthly_cost > 0 && sumC(md) >= b.monthly_cost) { 
    over = true; warnings.push(`Monthly cost: ${money.format(sumC(md))}/${money.format(b.monthly_cost)}`) 
  }
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
  const legacyGlobal = migrateLegacyTokenMode((raw as any).token_mode)
  const token = mergeTokenPolicy(raw.token)
  return {
    ...initial,
    ...raw,
    token: { ...token, global: legacyGlobal ?? token.global },
    budget: { ...initial.budget, ...(raw.budget ?? {}) },
  }
}

function saveCfg(api: TuiPluginApi, cfg: Config) { api.kv.set(KV_CFG, cfg) }

// Title cache
const titleCache = new Map<string, string>()

export function rememberTitle(api: TuiPluginApi, sid: string, title: string) {
  if (!sid || !title) return
  titleCache.set(sid, title)

  try {
    const store = readDisk(api)
    const titles = { ...(store.titles || {}) }
    if (titles[sid] === title) return
    titles[sid] = title
    writeDisk(api, { ...store, titles })
  } catch {}
}

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
  const titles = { ...(store.titles || {}) }
  for (const [sid, t] of titleCache) { if (!titles[sid]) titles[sid] = t }
  writeDisk(api, { entries: [...store.entries, entry], seen: [...store.seen, msg.id], titles })
}

// ── Title refresh ─────────────────────────────────────────────────────

export async function refreshTitles(api: TuiPluginApi) {
  try {
    const store = readDisk(api)
    const titles = { ...(store.titles || {}) }
    for (const [sid, t] of Object.entries(titles)) { titleCache.set(sid, t) }
    const res = await api.client.session.list() as any
    const sessions = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
    let changed = false
    for (const s of sessions) {
      if (s.id && s.title && titles[s.id] !== s.title) {
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
    if (tick) tick()

    // Usage: all periods + daily avg
    const lines = ALL_PERIODS.map((p) => {
      const f = periodFilter(entries, p)
      const tokens = aggSeparate(f, c)
      const co = sumC(f)
      const costStr = co > 0 ? ` · ${money.format(co)}` : ""
      const displayParts: string[] = []
      if (c.show_separate) {
        displayParts.push(`↑${fmt(tokens.input)}`)
        displayParts.push(`↓${fmt(tokens.output)}`)
        if (c.show_reasoning && tokens.reasoning > 0) displayParts.push(`r${fmt(tokens.reasoning)}`)
        if (c.show_cache && tokens.cache > 0) displayParts.push(`📦${fmt(tokens.cache)}`)
      }
      const displayStr = c.show_separate ? displayParts.join(" ") : fmt(tokens.total)
      return { title: periodLabel(p), value: `period:${p}`, description: `${displayStr}${costStr}`, category: "Usage" }
    })
    lines.push({ title: `Daily avg: ${dailyAvg(entries, c)}/day`, value: "noop", description: sparkline(entries, c), category: "Usage" })

    // Models: top 3
    const models = new Map<string, { total: number; cost: number; count: number }>()
    for (const e of entries) {
      const k = e.model || "unknown"
      const cur = models.get(k) ?? { total: 0, cost: 0, count: 0 }
      cur.total += calcTokens(e, resolveTokenFlags(e, c)).total; cur.cost += e.cost; cur.count++
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
      cur.tokens += calcTokens(e, resolveTokenFlags(e, c)).total; cur.cost += e.cost; cur.count++
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

    const settings = [
      { title: "Global token mode (default)", value: "cfg:token_global", description: `Default for unknown providers · ${tokenModeLabel(c.token.global)}`, category: "Counting" },
      { title: "Provider presets (per provider)", value: "cfg:token_providers", description: "Source-backed where possible: Claude, OpenAI, Codex, Kimi...", category: "Counting" },
      { title: "Custom token flags (manual)", value: "cfg:token_custom", description: "Manual input/output/reasoning/cache flags", category: "Counting" },
      { title: "Show separate (↑↓)", value: "cfg:show_separate", description: c.show_separate ? "On · show input/output split" : "Off · show only totals", category: "Display" },
      { title: "Show reasoning", value: "cfg:show_reasoning", description: c.show_reasoning ? "On · include reasoning tokens" : "Off · hide reasoning tokens", category: "Display" },
      { title: "Show cache", value: "cfg:show_cache", description: c.show_cache ? "On · include cache tokens" : "Off · hide cache tokens", category: "Display" },
      { title: "Show cost", value: "cfg:show_cost", description: c.show_cost ? "On · show estimated cost" : "Off · tokens only", category: "Display" },
      { title: "Sidebar periods", value: "cfg:footer_periods", description: c.footer_periods.map((p) => periodLabel(p)).join(", "), category: "Placement" },
      { title: "Sidebar compact", value: "cfg:compact", description: c.compact ? "On · tighter sidebar text" : "Off · full labels", category: "Placement" },
      { title: "Prompt periods", value: "cfg:prompt_periods", description: c.prompt_periods.map((p) => periodLabel(p)).join(", "), category: "Placement" },
      { title: "Prompt compact", value: "cfg:prompt_compact", description: c.prompt_compact ? "On · minimal prompt text" : "Off · verbose prompt text", category: "Placement" },
      { title: "Budget alerts", value: "cfg:budget_menu", description: c.budget.enabled ? "On · warn on thresholds" : "Off", category: "Advanced" },
      { title: "Export report", value: "action:export", description: "Copy a summary to clipboard", category: "Advanced" },
      { title: `Reset data (${entries.length})`, value: "action:reset", description: "Delete all stored token history", category: "Danger" },
    ]

    return [...lines, ...modelRows, ...recentRows, ...topRows, ...settings]
  }

  refreshTitles(api).catch(() => {})

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="BetterToken"
      options={buildOptions()}
      onSelect={(item: any) => {
        const v = item.value as string
        if (v === "noop") return showMain(api, cfg, setCfg, tick)
        if (v === "cfg:token_global") return showTokenGlobalPicker(api, cfg, setCfg, tick)
        if (v === "cfg:token_providers") return showProviderPresetPicker(api, cfg, setCfg, tick)
        if (v === "cfg:token_custom") return showTokenCustomPicker(api, cfg, setCfg, tick)
        if (v === "cfg:show_separate") { const n = { ...cfg(), show_separate: !cfg().show_separate }; setCfg(n); saveCfg(api, n); return showMain(api, cfg, setCfg, tick) }
        if (v === "cfg:show_cache") { const n = { ...cfg(), show_cache: !cfg().show_cache }; setCfg(n); saveCfg(api, n); return showMain(api, cfg, setCfg, tick) }
        if (v === "cfg:show_reasoning") { const n = { ...cfg(), show_reasoning: !cfg().show_reasoning }; setCfg(n); saveCfg(api, n); return showMain(api, cfg, setCfg, tick) }
        if (v === "cfg:show_cost") { const n = { ...cfg(), show_cost: !cfg().show_cost }; setCfg(n); saveCfg(api, n); return showMain(api, cfg, setCfg, tick) }
        if (v === "cfg:compact") { const n = { ...cfg(), compact: !cfg().compact }; setCfg(n); saveCfg(api, n); return showMain(api, cfg, setCfg, tick) }
        if (v === "cfg:prompt_compact") { const n = { ...cfg(), prompt_compact: !cfg().prompt_compact }; setCfg(n); saveCfg(api, n); return showMain(api, cfg, setCfg, tick) }
        if (v === "cfg:footer_periods") return showFooterPeriodPicker(api, cfg, setCfg, tick)
        if (v === "cfg:prompt_periods") return showPromptPeriodPicker(api, cfg, setCfg, tick)
        if (v === "cfg:budget_menu") return showBudgetMenu(api, cfg, setCfg, tick)
        if (v === "action:reset") return showResetConfirm(api, cfg, setCfg, tick)
        if (v === "action:export") return doExport(api, cfg)

        showMain(api, cfg, setCfg, tick)
      }}
    />
  ))
}

function showFooterPeriodPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Sidebar Periods"
      options={[
        ...ALL_PERIODS.map((p) => ({ title: `${cfg().footer_periods.includes(p) ? "[x]" : "[ ]"} ${periodLabel(p)}`, value: p })),
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        const c = cfg(), p = item.value as Period
        const periods = c.footer_periods.includes(p) ? c.footer_periods.filter((x) => x !== p) : [...c.footer_periods, p]
        const n = { ...c, footer_periods: periods }; setCfg(n); saveCfg(api, n); showFooterPeriodPicker(api, cfg, setCfg, tick)
      }}
    />
  ))
}

function showPromptPeriodPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Prompt Periods"
      options={[
        ...ALL_PERIODS.map((p) => ({ title: `${cfg().prompt_periods.includes(p) ? "[x]" : "[ ]"} ${periodLabel(p)}`, value: p })),
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        const c = cfg(), p = item.value as Period
        const periods = c.prompt_periods.includes(p) ? c.prompt_periods.filter((x) => x !== p) : [...c.prompt_periods, p]
        const n = { ...c, prompt_periods: periods }; setCfg(n); saveCfg(api, n); showPromptPeriodPicker(api, cfg, setCfg, tick)
      }}
    />
  ))
}

function showTokenGlobalPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  const modes: TokenMode[] = ["estimate", "api_billed", "output_only", "custom"]
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Global Token Mode"
      options={[
        ...modes.map((m) => ({
          title: `${m === cfg().token.global ? "[x]" : "[ ]"} ${tokenModeLabel(m)}`,
          value: m,
          description: m === "estimate"
            ? "Best default for mixed providers"
            : m === "api_billed"
              ? "Includes cache when billing is documented"
              : m === "output_only"
                ? "Only count model output"
                : "Manual per-token flags",
        })),
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        const n = { ...cfg(), token: { ...cfg().token, global: item.value as TokenMode } }
        setCfg(n); saveCfg(api, n); showMain(api, cfg, setCfg, tick)
      }}
    />
  ))
}

function showProviderPresetPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  const providers: ProviderKey[] = ["claude", "openai", "gemini", "glm", "kimi", "minimax", "codex", "deepseek", "qwen", "mistral", "grok", "local", "other"]
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Provider Presets"
      options={[
        ...providers.map((p) => ({
          title: PROVIDER_PRESET_INFO[p].label,
          value: p,
          description: `${tokenModeLabel(cfg().token.providers[p] ?? cfg().token.global)} · ${PROVIDER_PRESET_INFO[p].note} · ${PROVIDER_PRESET_INFO[p].source}`,
        })),
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        showProviderModePicker(api, cfg, setCfg, item.value as ProviderKey, tick)
      }}
    />
  ))
}

function showProviderModePicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, provider: ProviderKey, tick?: () => number) {
  const modes: TokenMode[] = ["estimate", "api_billed", "output_only", "custom"]
  const current = cfg().token.providers[provider] ?? cfg().token.global
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`${PROVIDER_PRESET_INFO[provider].label} Preset`}
      options={[
        ...modes.map((m) => ({
          title: `${m === current ? "[x]" : "[ ]"} ${tokenModeLabel(m)}`,
          value: m,
          description: m === "estimate"
            ? "Safe default: input + output + reasoning"
            : m === "api_billed"
              ? "Use when the provider documents cached input billing"
              : m === "output_only"
                ? "Only count generated output"
                : "Manual flags for edge cases",
        })),
        { title: "Reset to global", value: "reset" },
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showProviderPresetPicker(api, cfg, setCfg, tick)
        const token = { ...cfg().token }
        if (item.value === "reset") {
          const providers = { ...token.providers }
          delete providers[provider]
          const n = { ...cfg(), token: { ...token, providers } }
          setCfg(n); saveCfg(api, n); return showProviderModePicker(api, cfg, setCfg, provider, tick)
        }
        const n = { ...cfg(), token: { ...token, providers: { ...token.providers, [provider]: item.value as TokenMode } } }
        setCfg(n); saveCfg(api, n); showProviderModePicker(api, cfg, setCfg, provider, tick)
      }}
    />
  ))
}

function showTokenCustomPicker(api: TuiPluginApi, cfg: () => Config, setCfg: (c: Config) => void, tick?: () => number) {
  const c = cfg()
  const custom = c.token.custom
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Custom Token Flags"
      options={[
        { title: `Input: ${custom.input ? "On" : "Off"}`, value: "input" },
        { title: `Output: ${custom.output ? "On" : "Off"}`, value: "output" },
        { title: `Reasoning: ${custom.reasoning ? "On" : "Off"}`, value: "reasoning" },
        { title: `Cache read: ${custom.cache_read ? "On" : "Off"}`, value: "cache_read" },
        { title: `Cache write: ${custom.cache_write ? "On" : "Off"}`, value: "cache_write" },
        { title: "Reset defaults", value: "reset" },
        { title: "<- Back", value: "back" },
      ]}
      onSelect={(item: any) => {
        if (item.value === "back") return showMain(api, cfg, setCfg, tick)
        if (item.value === "reset") {
          const n = { ...cfg(), token: { ...c.token, custom: { ...NO_CUSTOM } } }
          setCfg(n); saveCfg(api, n); return showTokenCustomPicker(api, cfg, setCfg, tick)
        }
        const key = item.value as keyof TokenFlags
        const n = { ...cfg(), token: { ...c.token, custom: { ...custom, [key]: !custom[key] } } }
        setCfg(n); saveCfg(api, n); showTokenCustomPicker(api, cfg, setCfg, tick)
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
  for (const p of ALL_PERIODS) { const f = periodFilter(entries, p); lines.push(`${periodLabel(p)}: ${fmt(aggByMode(f, c))} tokens · ${money.format(sumC(f))}`) }
  lines.push("", `Daily avg: ${dailyAvg(entries, c)}/day`, `Sparkline: ${sparkline(entries, c)}`, "", `Total entries: ${entries.length}`, `Generated: ${new Date().toISOString()}`)
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
    return { text: formatStats(entries, c, c.footer_periods, c.compact), over: checkBudget(entries, c).over }
  })
  return <text fg={data().over ? "#EF4444" : theme().textMuted} wrapMode="none">{data().over ? "! " : ""}{data().text}</text>
}

// View for the prompt area (session_prompt_right slot) - like TPS meter
export function PromptView(props: { api: TuiPluginApi; cfg: () => Config; tick: () => number; sessionID: string }) {
  const theme = () => props.api.theme.current
  const data = createMemo(() => {
    props.tick()
    const entries = readDisk(props.api).entries, c = props.cfg()
    const text = formatStats(entries, c, c.prompt_periods, c.prompt_compact)
    const over = checkBudget(entries, c).over
    return { text, over }
  })
  return <text fg={data().over ? "#EF4444" : theme().textMuted}>{data().text}</text>
}
