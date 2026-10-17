import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Env, Flow, Panel, Phase, PlannedTask } from '../types'

const flow = atom({ plugin: 'crew-deck', key: 'flow' } as const, null)
const agents = atom({ plugin: 'crew-deck', key: 'agents' } as const, [])
const panel = atom({ plugin: 'crew-deck', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  expanded: [],
  autoOpenedFor: '',
})
const now = atom({ plugin: 'crew-deck', key: 'now' } as const, 0)
// Where the session works (folder, its parent, git branch) and how full
// its context is, for the panel's header.
const env = atom({ plugin: 'crew-deck', key: 'env' } as const, { folder: '', path: '' } as Env)

const TOOL = 'mcp__crew-deck__progress'
const STEP_TOOL = 'mcp__crew-deck__step'
const PANE = 'crew-deck'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
// Palette in one place. Accent = Claude clay.
const ACCENT = '#D97757'
const DONE = '#4FA37A'
const FAILED = '#D0453F'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Russian.

type Lang = 'en' | 'ru'

const STRINGS = {
  en: {
    pane: 'Crew Deck',
    context: 'Context',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    unfold: 'Show details',
    fold: 'Hide details',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No subagents yet',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    agentsCount: 'agents',
    isRunning: 'running',
    isFinished: 'finished',
    isPlanned: 'planned',
    opened: 'Crew Deck opened.',
    closed: 'Crew Deck closed.',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'running',
    sub: 'sub',
  },
  ru: {
    pane: 'Crew Deck',
    context: 'Контекст',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    unfold: 'Подробнее',
    fold: 'Скрыть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Crew Deck открыт.',
    closed: 'Crew Deck закрыт.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
    sub: 'суб',
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return isRussian(settings.language) ? 'ru' : 'en'
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return isRussian(locale) ? 'ru' : 'en'
}

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && input.title.trim() !== prev.title)

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: (t.tier ?? '').replace(/^savvy-/, '').trim().toLowerCase(),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total)))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: input.title?.trim() || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(f)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(f) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'other', false, isWorking, 0.8)}
</svg>`
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

// Okabe-Ito hues darkened to pass 4.5:1 on white (redesign research).
// On agent rows they only tint the crab's costume; the tier name stays grey.
const TIER_COLOR: Record<string, string> = {
  fable: '#A0508F',
  heavy: '#B34E00',
  careful: '#8F6400',
  medium: '#0067A6',
  light: '#00785A',
  other: '#55544F',
  explore: '#6E6A00',
}

// What each savvy tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, string> = {
  fable: 'Fable · high',
  heavy: 'Opus · xhigh',
  careful: 'Opus · high',
  medium: 'Opus · medium',
  light: 'Opus · low',
}

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so the panel's cost is an estimate.
// List prices from platform.claude.com/docs/en/about-claude/pricing,
// checked 2026-10-17. First match wins, so specific versions go first.
type Price = [number, number, number, number]
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 12.5]],
  [/fable|mythos/, [10, 50, 1, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet-5-5/, [2, 10, 0.1, 2.5]],
  [/sonnet-5/, [2, 10, 0.2, 2.5]],
  [/sonnet/, [3, 15, 0.3, 3.75]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.125]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

// Haiku 5.5 bills a request whose prompt (input + cache) passes 100k
// tokens at these prices instead.
const HAIKU_5_5_LONG: Price = [0.5, 2.5, 0.05, 0.625]
const HAIKU_5_5_LIMIT = 100_000

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// Everything the request sent, cached or not.
const inputOf = (u: Usage): number =>
  (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const priceOf = (model: string, prompt = 0): Price => {
  const id = model.toLowerCase()
  if (/haiku-5-5/.test(id) && prompt > HAIKU_5_5_LIMIT) return HAIKU_5_5_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 5]
}

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model, inputOf(u))
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 5.5 has the 1M window; older Haikus keep 200k.
const windowOf = (model: string): number => (/haiku/i.test(model) && !/haiku-5-5/i.test(model) ? 200_000 : 1_000_000)

// `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return t in TIER_COLOR && bare.startsWith('savvy-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// ---------------------------------------------------------------------------
// The tree of spawns. `agent.spawn` records the loop each run was
// spawned from; a run whose parent is not in the list (main thread, trimmed,
// cleared by a new flow) is a root. A family is a root and all its descendants.

const MAX_DEPTH = 3
const INDENT = 18
const RAIL_OFFSET = 10
const SUB_CRAB_SCALE = 0.85

type TreeRow = {
  a: AgentRun
  depth: number
  /** rails[level]: the ancestor at that depth has later siblings, so its line runs on. */
  rails: boolean[]
  isLast: boolean
  isGroupEnd: boolean
  /** Every descendant, not just direct children. */
  kids: number
}

type Family = { rows: TreeRow[]; isRunning: boolean; runs: number }

const familiesOf = (list: AgentRun[]): Family[] => {
  const byAgentId = new Map(list.filter(a => a.agentId).map(a => [a.agentId as string, a]))
  const parentOf = (a: AgentRun): AgentRun | undefined => {
    const p = a.parentAgentId ? byAgentId.get(a.parentAgentId) : undefined
    return p && p.id !== a.id ? p : undefined
  }
  const children = new Map<string, AgentRun[]>()
  const roots: AgentRun[] = []
  for (const a of list) {
    const p = parentOf(a)
    if (!p) roots.push(a)
    else children.set(p.id, [...(children.get(p.id) ?? []), a])
  }
  const seen = new Set<string>()
  const walk = (a: AgentRun, depth: number, rails: boolean[], isLast: boolean, out: TreeRow[]): void => {
    if (seen.has(a.id)) return
    seen.add(a.id)
    const at = out.length
    out.push({ a, depth, rails, isLast, isGroupEnd: false, kids: 0 })
    const kids = children.get(a.id) ?? []
    // Below this run, its own rail runs on while it has later siblings.
    const next = rails.slice()
    next[depth] = depth > 0 && !isLast
    kids.forEach((c, i) => walk(c, depth + 1, next, i === kids.length - 1, out))
    const row = out[at]
    if (row) row.kids = out.length - at - 1
  }
  // A parent loop that never reaches a root (it should not happen) still shows: its runs become roots.
  const families = (rs: AgentRun[]): Family[] =>
    rs.flatMap(r => {
      if (seen.has(r.id)) return []
      const rows: TreeRow[] = []
      walk(r, 0, [], true, rows)
      const last = rows[rows.length - 1]
      if (last) last.isGroupEnd = true
      return [{ rows, isRunning: rows.some(x => x.a.status === 'running'), runs: rows.length }]
    })
  const out = families(roots)
  return [...out, ...families(list.filter(a => !seen.has(a.id)))]
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

// Palette from the redesign research (Few, Carbon, Okabe-Ito, WCAG):
// grey text in three steps, one hue per state, every color with a dark variant.
// Text passes 4.5:1 and marks 3:1 on #FFFFFF / #1F1F1E. `.cR` running, `.cF`
// failed, `.cG` `.cW` `.cO` `.cF` the header's context by level (green, amber,
// orange, red), `.bf` an agent's body (`--b`).
// Metrics: `.mvC` cost in a muted teal, the only colored figure on a row; time,
// context and tokens in the grey `.ml`; the words `ctx`, `in`, `out` and the
// agent type lighter still, `.mk`
// (about 2.6:1, below 4.5:1 on purpose: they name columns the values explain).
const BODY_COLORS: [string, string][] = [
  ['#C96442', '#D97757'],
  ['#0072B2', '#56B4E9'],
  ['#009E73', '#2BBE8E'],
  ['#B8609A', '#CC79A7'],
  ['#B97A00', '#E69F00'],
  ['#2A86BD', '#7CC4EE'],
  ['#7F7A00', '#C9C24A'],
  ['#66717D', '#9AA4AF'],
]
const bodyCss = (i: 0 | 1): string => BODY_COLORS.map((c, n) => `.b${n}{--b:${c[i]}}`).join('')
const PANE_CSS = `<style>
.t{fill:#1F1F1E}.s{fill:#55544F}.m{fill:#73726D}.k{fill:#E6E5E1}.ln{stroke:#ECEBE7}.tile{fill:#F4F3F0}.tr{stroke:#D3D2CD;stroke-width:1.2;fill:none;stroke-linecap:round}
.mvC{fill:#2B6A62}.ml{fill:#73726D}.mk{fill:#A3A29C}
.cR{fill:#B5532F}.cF{fill:#C42B2B}.cW{fill:#9A5B00}.cG{fill:#2E7D52}.cO{fill:#B34E00}.sF{stroke:#C42B2B}.sM{stroke:#73726D}.bf{fill:var(--b)}${bodyCss(0)}
@media (prefers-color-scheme: dark){.t{fill:#ECEBE8}.s{fill:#BDBCB6}.m{fill:#97968F}.k{fill:#3A3A37}.ln{stroke:#2E2E2C}.tile{fill:#262625}.tr{stroke:#4A4A47}
.mvC{fill:#8FC8BF}.ml{fill:#97968F}.mk{fill:#6C6B66}
.cR{fill:#E08A6B}.cF{fill:#F2726B}.cW{fill:#E8A33D}.cG{fill:#5DBE8A}.cO{fill:#F08A4B}.sF{stroke:#F2726B}.sM{stroke:#97968F}${bodyCss(1)}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
// Each agent run gets its own body color, in launch order, cycling.
// The terminal takes the light variant; an SVG takes `BODY` and the row's `.bN` class.
const bodyIndexOf = (list: AgentRun[], a: AgentRun): number => {
  const i = list.findIndex(x => x.id === a.id)
  return ((i % BODY_COLORS.length) + BODY_COLORS.length) % BODY_COLORS.length
}
const bodyOf = (list: AgentRun[], a: AgentRun): string => BODY_COLORS[bodyIndexOf(list, a)]?.[0] ?? CLAY
const BODY = 'var(--b)'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, body: string, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, body)
  f(3, 14, 4, 4, body)
  f(23, 14 + armFront, 4, 4, body, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, body, 'la')
  f(17, 22, 2, 4, body, 'la')
  f(11, 22, 2, 4, body, 'lb')
  f(21, 22, 2, 4, body, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string, b: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t, b) => {
    crabBody(f, b)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t, b) => {
    crabBody(f, b, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t, b) => {
    crabBody(f, b)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t, b) => {
    crabBody(f, b, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t, b) => {
    crabBody(f, b, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: (f, _t, b) => {
    crabBody(f, b)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: (f, _t, b) => crabBody(f, b),
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE, bodyColor = CLAY): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    const paint = c === BODY ? 'class="bf"' : `fill="${c}"`
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" ${paint}/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g, bodyColor))
  draw(f, colorOf(costume), bodyColor)
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  // Running is a pulsing clay dot, done a grey check, failed a red cross.
  if (status === 'running') return `<circle class="live cR" cx="${x}" cy="${y}" r="3"/>`
  if (status === 'done') return `<path class="sM" d="M${x - 4} ${y}l2.8 2.8 5.2-5.6" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path class="sF" d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title says "Crew Deck": the header names the flow, if any.
// The header has two bands. Above, the folder, its parent path and
// the git branch in a pill; below, context, tokens, cost and time, each value
// under its label, the last three on the agent rows' metric columns. Only the
// cost and the context carry color and weight.
const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,monospace"
const monoWidth = (s: string, size: number): number => [...s].length * 0.6 * size

// Cuts the middle out of `s` to fit `maxW`, keeping its start and its end.
const fitMiddle = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  const chars = [...s]
  let head = Math.ceil(chars.length / 2)
  let tail = Math.floor(chars.length / 2)
  while (head + tail > 1 && textWidth(`${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`, size) > maxW) {
    if (head > tail) head--
    else tail--
  }
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

const BRANCH_ICON = (x: number, y: number): string =>
  `<g transform="translate(${x},${y})" class="sM" fill="none" stroke-width="1.2" stroke-linecap="round"><circle cx="2" cy="2" r="1.5"/><circle cx="2" cy="10" r="1.5"/><circle cx="8" cy="4" r="1.5"/><path d="M2 3.5v5M8 5.5c0 2.5-6 2-6 3"/></g>`

// The header's context figure and bar change color as the main thread fills up:
// green below 40%, amber below 50%, orange below 60%, red from there.
const ctxLevel = (pct: number): string => (pct < 40 ? 'cG' : pct < 50 ? 'cW' : pct < 60 ? 'cO' : 'cF')

const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>, where: Env): string => {
  const s = tr()
  const top = title ? 28 : 0
  const [c1, c2, c3] = metricEdges(W - ARROW_W - 24)
  const text = (x: number, y: number, size: number, cls: string, body: string, extra = ''): string =>
    `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-variant-numeric="tabular-nums"${extra}>${body}</text>`
  const end = ' text-anchor="end"'
  const bold = ' font-weight="600"'

  // Band 1: folder, then its parent path, then the branch pill ending on column 3.
  const yId = top + 23
  let pill = ''
  let pillX = c3
  if (where.branch) {
    const maxText = Math.max(30, W * 0.4 - 26)
    let branch = where.branch
    while (branch.length > 2 && monoWidth(branch, 11) > maxText) branch = branch.slice(0, -2) + '…'
    const pw = Math.round(26 + monoWidth(branch, 11))
    pillX = c3 - pw
    pill =
      `<rect class="tile" x="${pillX}" y="${top + 12}" width="${pw}" height="18" rx="6"/>${BRANCH_ICON(pillX + 6, top + 15)}` +
      `<text class="s" x="${pillX + 20}" y="${top + 25}" font-family="${MONO}" font-size="11">${xml(branch)}</text>`
  }
  const folder = fitText(where.folder || '—', 13, Math.max(40, pillX - 12 - 60))
  const pathX = Math.round(textWidth(folder, 13) * 1.04 + 6)
  const pathW = pillX - 12 - pathX
  const path = where.path && pathW > 30 ? text(pathX, yId, 11, 'm', xml(fitMiddle(where.path, 11, pathW))) : ''

  // Band 2: labels, then values 20 px lower; context left, the rest on columns.
  const yLab = top + 55
  const yVal = top + 75
  const pct = where.ctxPct
  const pctClass = ctxLevel(pct ?? 0)
  const fill = pct === undefined ? 0 : Math.round((48 * Math.min(100, pct)) / 100)
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" x="0" y="15" font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${text(0, yId, 13, 't', xml(folder), bold)}${path}${pill}
${text(0, yLab, 11, 'm', s.context)}${text(c1, yLab, 11, 'm', s.tokens, end)}${text(c2, yLab, 11, 'm', s.cost, end)}${text(c3, yLab, 11, 'm', s.time, end)}
${pct === undefined ? text(0, yVal, 14, 'm', '—', bold) : text(0, yVal, 14, pctClass, `${pct}%`, bold)}
${text(c1, yVal, 14, 'ml', xml(fmtTokens(t.tokens)), end)}${text(c2, yVal, 14, 'mvC', xml(fmtCost(t.cost)), end + bold)}${text(c3, yVal, 14, 'ml', xml(fmtTime(t.time)), end)}
<rect class="k" x="0" y="${yVal + 5}" width="48" height="2" rx="1"/><rect class="${pctClass}" x="0" y="${yVal + 5}" width="${fill}" height="2" rx="1"/>
<line class="ln" x1="0" y1="${top + HEADER_H - 0.5}" x2="${W}" y2="${top + HEADER_H - 0.5}"/>`,
  )
}

// 96 px, with 20 px of air under the values before the line.
const HEADER_H = 96
// "No subagents yet" in 11 px and the `.mk` grey of `ctx`, `in` and `out`.
const EMPTY_H = 18
const emptySvg = (W: number, text: string): string =>
  svg(W, EMPTY_H, `<text class="mk" x="0" y="13" font-family="${FONT}" font-size="11">${xml(text)}</text>`)

const headerHeight = (title: string): number => (title ? 28 : 0) + HEADER_H

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

// Rows are taller and airier. A run that ended well folds to one line
// on its own; its arrow unfolds it. Failed and running runs always show in full.
const isFolded = (a: AgentRun, p: Panel): boolean => a.status === 'done' && !(p.expanded ?? []).includes(a.id)

// Height, gap between text lines, crab scale and where the text starts. Text
// blocks and the crab sit centred in the row.
type RowGeom = { H: number; gap: number; scale: number; textX: number }
const FULL_ROOT: RowGeom = { H: 76, gap: 19, scale: 0.9, textX: 38 }
const FULL_SUB: RowGeom = { H: 64, gap: 17, scale: 0.7, textX: 30 }
const FOLD_ROOT: RowGeom = { H: 38, gap: 0, scale: 0.6, textX: 26 }
const FOLD_SUB: RowGeom = { H: 32, gap: 0, scale: 0.5, textX: 22 }
const geomOf = (r: TreeRow, isFold: boolean): RowGeom =>
  r.depth > 0 ? (isFold ? FOLD_SUB : FULL_SUB) : isFold ? FOLD_ROOT : FULL_ROOT

const rowHeight = (r: TreeRow, isFold = false): number => geomOf(r, isFold).H

// Baselines of `n` lines `gap` apart, centred on the row (+4: half a cap height).
const baselines = (H: number, n: number, gap: number): number[] =>
  Array.from({ length: n }, (_, k) => Math.round(H / 2 + 4 - ((n - 1) * gap) / 2 + k * gap))

// The crab's body spans rows 10 to 26 of its 28-row grid: centre that.
const crabTop = (H: number, sc: number): number => Math.round(H / 2 - 18 * sc)

// The metrics form a borderless table of three right-aligned columns, the same
// widths on every row, so cost, time and tokens line up down the whole list.
const COL_GAP = 20
// Room kept right of each desktop row for its fold arrow.
const ARROW_W = 20
// A foldable row lights while hovered. A translucent grey reads on
// both themes; no theme key paints a background.
const ROW_HOVER = 'rgba(128,128,128,0.08)'
// Widths also fit the header's 14 px bold totals (bold runs ~6% wider).
const HEADER_BOLD = 1.06
const METRIC_COLS: [number, number, number] = [
  Math.max(textWidth('888k', 11), textWidth('8.8M', 14) * HEADER_BOLD),
  Math.max(textWidth('in 8.8M', 11), textWidth('$88.88', 14) * HEADER_BOLD),
  Math.max(textWidth('out 888k', 11), textWidth('8:88:88', 14) * HEADER_BOLD),
]
// Right edge of each column, from the row's right edge.
const metricEdges = (RX: number): [number, number, number] => {
  const [, w2, w3] = METRIC_COLS
  const c3 = RX
  const c2 = c3 - w3 - COL_GAP
  return [c2 - w2 - COL_GAP, c2, c3]
}

const altOf = (r: TreeRow, state: string): string =>
  `${r.depth > 0 ? '↳ ' : ''}${r.a.description || r.a.type}: ${modelName(r.a.model)}, ${state}${r.kids > 0 ? `, ${r.kids} ${tr().sub}` : ''}` +
  // A folded row still says its cost and tokens to a screen reader.
  `, ${fmtCost(r.a.costUsd)}, ${fmtTokens(r.a.tokens)} ${tr().tokensWord}`

// Steps as small blocks after "3/5" (a thin bar past 8 steps). Returns the markup
// and the width it took.
const MAX_STEP_BLOCKS = 8
const stepBlocks = (x: number, base: number, done: number, total: number): [string, number] => {
  if (total > MAX_STEP_BLOCKS) {
    const w = 48
    const fill = Math.round((w * Math.min(done, total)) / total)
    return [`<rect class="k" x="${x}" y="${base - 6}" width="${w}" height="3" rx="1.5"/><rect class="cR" x="${x}" y="${base - 6}" width="${fill}" height="3" rx="1.5"/>`, w]
  }
  const blocks = Array.from({ length: total }, (_, k) => `<rect class="${k < done ? 'cR' : 'k'}" x="${x + k * 8}" y="${base - 7}" width="6" height="4" rx="1"/>`)
  return [blocks.join(''), total * 8 - 2]
}

// A row knows its place in the tree of spawns. Subagents draw smaller,
// indented under the run that spawned them, joined to it by tree lines.
// The "two densities" layout. In full, the left block (title; type,
// model and effort; steps and note) faces the metrics table (cost, time; context;
// total, sent and generated tokens). Folded, the title faces cost and time.
const agentSvg = (W: number, row: TreeRow, at: number, bodyIdx: number, isFold = false): string => {
  const { a } = row
  const s = tr()
  const d = Math.min(row.depth, MAX_DEPTH)
  const isSub = d > 0
  const ind = d * INDENT
  const g = geomOf(row, isFold)
  const { H, scale: sc } = g
  const crabY = crabTop(H, sc)
  const x0 = ind + g.textX
  const RX = W - 24
  const [c1, c2, c3] = metricEdges(RX)
  const crabBottom = crabY + Math.round(28 * sc)

  // Tree lines: ancestors with later siblings keep their rail; this row's own
  // elbow; a stub down from the crab when children follow.
  const railX = (level: number): number => (level - 1) * INDENT + RAIL_OFFSET
  const midY = crabY + Math.round(14 * sc)
  const lines: string[] = []
  for (let level = 1; level < d; level++) {
    if (row.rails[level]) lines.push(`<line class="tr" x1="${railX(level)}" y1="0" x2="${railX(level)}" y2="${H}"/>`)
  }
  if (isSub) {
    const x = railX(d)
    lines.push(`<path class="tr" d="M${x} 0V${row.isLast ? midY - 4 : H}"/>`)
    lines.push(`<path class="tr" d="M${x} ${midY - 4}q0 4 4 4H${ind - 2}"/>`)
  }
  if (row.kids > 0 && row.depth < MAX_DEPTH) {
    const x = railX(d + 1)
    lines.push(`<line class="tr" x1="${x}" y1="${crabBottom + 2}" x2="${x}" y2="${H}"/>`)
  }

  const text = (x: number, y: number, size: number, cls: string, body: string, extra = ''): string =>
    `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-variant-numeric="tabular-nums"${extra}>${body}</text>`
  const end = ' text-anchor="end"'
  const cell = (x: number, y: number, size: number, cls: string, body: string): string => (body ? text(x, y, size, cls, body, end) : '')
  const cost = fmtCost(a.costUsd)
  const time = fmtTime(elapsed(a, at))
  const crabSvg = `<g class="b${bodyIdx}">${crab(ind, crabY, costumeOf(a.type), false, a.status === 'running', sc, BODY)}</g>`
  const groupEnd = row.isGroupEnd ? `<line class="ln" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>` : ''
  const mark = statusMark(W - 8, Math.round(H / 2), a.status, '')

  if (isFold) {
    const [y] = baselines(H, 1, 0)
    const size = isSub ? 11 : 12
    const titleW = Math.max(0, c2 - METRIC_COLS[1] - x0 - 12)
    return svg(
      W,
      H,
      `${lines.join('')}${crabSvg}
${text(x0, y ?? 0, size, 's', xml(fitText(a.description || a.type, size, titleW)), ' font-weight="500"')}
${text(c2, y ?? 0, 11, 'mvC', xml(cost), `${end} font-weight="600"`)}${cell(c3, y ?? 0, 11, 'ml', xml(time))}
${mark}${groupEnd}`,
    )
  }

  const ctx = ctxOf(a)
  const fmtSplit = (n: number | undefined): string => (n === undefined ? '—' : fmtTokens(n))
  const [titleSize, s1] = isSub ? [11, 11] : [12, 12]
  const [r1 = 0, r2 = 0, r3 = 0] = baselines(H, 3, g.gap)
  // Tokens: the total bare, then sent and generated, each after its label. Only
  // cost, context percentage and time stand out; the rest share the labels' grey.
  const labelled = (label: string, v: string): string => `<tspan class="mk">${label}</tspan> ${xml(v)}`
  const metrics = [
    text(c2, r1, s1, 'mvC', xml(cost), `${end} font-weight="600"`),
    cell(c3, r1, s1, 'ml', xml(time)),
    cell(c1, r2, 11, 'mk', 'ctx'),
    text(c2, r2, 11, 'ml', `${ctx}%`, `${end} font-weight="600"`),
    cell(c3, r2, 11, 'ml', xml(fmtTokens(a.contextTokens))),
    cell(c1, r3, 11, 'ml', xml(fmtTokens(a.tokens))),
    cell(c2, r3, 11, 'ml', labelled('in', fmtSplit(a.inputTokens))),
    cell(c3, r3, 11, 'ml', labelled('out', fmtSplit(a.outputTokens))),
  ].join('')

  // How far each left line may run before it meets the metrics beside it: row 1
  // leaves column 1 empty, row 2 holds only "ctx" there, row 3 is full width.
  const roomTo = (edge: number): number => Math.max(0, edge - x0 - 12)
  const titleW = roomTo(c2 - METRIC_COLS[1])
  const metaW = roomTo(c1 - textWidth('ctx', 11))
  const leftW = roomTo(c1 - METRIC_COLS[0])

  // Three lines, centred. Line 2 is the model and its effort (plus
  // round, subagents and failure); line 3 the agent type, then the steps.
  const [l1 = 0, l2 = 0, l3 = 0] = baselines(H, 3, g.gap)
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (row.kids > 0) meta.push(`↳ ${row.kids} ${s.sub}`)
  const failed = a.status === 'failed' ? ` · ${s.failed}` : ''
  const metaRich =
    xml(fitText(meta.join(' · '), 11, Math.max(0, metaW - textWidth(failed, 11)))) + (failed ? `<tspan class="cF" font-weight="600">${xml(failed)}</tspan>` : '')

  const typeLabel = tierOf(a.type) === 'other' ? a.type : tierOf(a.type)
  let line3 = ''
  if (a.stepTotal) {
    const total = a.stepTotal
    const done = a.stepDone ?? 0
    const count = `${done}/${total}`
    const [, bw] = stepBlocks(0, 0, done, total)
    // The steps come first in priority: the type gets what they leave.
    const stepsW = textWidth(count, 11) + 6 + bw
    const typeRoom = leftW - stepsW - 10
    const typeText = typeRoom >= 30 ? fitText(typeLabel, 11, typeRoom) : ''
    let x = x0 + (typeText ? textWidth(typeText, 11) + 10 : 0)
    if (typeText) line3 += text(x0, l3, 11, 'mk', xml(typeText))
    line3 += text(x, l3, 11, 't', count, ' font-weight="600"')
    x += textWidth(count, 11) + 6
    if (x + bw <= x0 + leftW) {
      line3 += stepBlocks(x, l3, done, total)[0]
      x += bw + 8
    }
    const noteW = x0 + leftW - x
    if (a.stepNote && noteW > 40) line3 += text(x, l3, 11, 's', xml(fitText(a.stepNote, 11, noteW)))
  } else {
    line3 = text(x0, l3, 11, 'mk', xml(fitText(typeLabel, 11, leftW)))
  }

  return svg(
    W,
    H,
    `${lines.join('')}${crabSvg}
${text(x0, l1, titleSize, 't', xml(fitText(a.description || a.type, titleSize, titleW)), ' font-weight="600"')}
${text(x0, l2, 11, 's', metaRich)}
${line3}
${metrics}
${mark}${groupEnd}`,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [TIER_MODEL[tier] ?? '']
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${crab(0, 6, tier, true)}
<text class="s" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier)}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

// Crabs in family order; subagents smaller and closer to their parent.
const compactSvg = (W: number, list: AgentRun[], rows: TreeRow[], planned: Planned[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...rows.map(r => ({ k: costumeOf(r.a.type), c: colorOf(tierOf(r.a.type)), s: r.a.status as string, dim: false, b: bodyOf(list, r.a), isSub: r.depth > 0 })),
    ...planned.map(p => ({ k: p.tier in TIER_COLOR ? p.tier : 'other', c: colorOf(p.tier), s: 'planned', dim: true, b: CLAY, isSub: false })),
  ]
  const step = (isSub: boolean): number => (isSub ? 28 : 36)
  const room = W - 150
  const body: string[] = []
  let x = 0
  let shown = 0
  for (const ic of icons) {
    if (x + step(ic.isSub) > room && shown > 0) break
    const sc = ic.isSub ? SUB_CRAB_SCALE * 0.85 : CRAB_SCALE
    body.push(crab(x, ic.isSub ? 6 : 0, ic.k, ic.dim, ic.s === 'running', sc, ic.b))
    if (ic.s === 'running') body.push(`<circle class="live cR" cx="${x + (ic.isSub ? 24 : 32)}" cy="${ic.isSub ? 8 : 4}" r="${ic.isSub ? 2.5 : 3}"/>`)
    x += step(ic.isSub)
    shown++
  }
  const more = icons.length - shown
  return svg(
    W,
    32,
    `${body.join('')}${more ? `<text class="s" x="${x + 4}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: tr().pane })
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: tr().pane })
}

// Folder, parent path and branch, read from the session and git. Runs
// at start, after each Bash call (a checkout moves the branch) and when the main
// thread ends a turn; never while drawing, which happens once a second.
async function refreshEnv($: EngineInterface): Promise<void> {
  const root = (await $.session.root()).replace(/\/+$/, '')
  const home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
  const cut = root.lastIndexOf('/')
  const folder = root.slice(cut + 1) || root
  const parent = cut > 0 ? root.slice(0, cut) : '/'
  const path = home && (parent === home || parent.startsWith(`${home}/`)) ? `~${parent.slice(home.length)}` : parent
  let branch: string | undefined
  try {
    const git = (args: string[]) => $.process.run(['git', ...args], { cwd: root, timeoutMs: 2000 })
    const r = await git(['branch', '--show-current'])
    if (r.exitCode === 0) branch = r.stdout.trim()
    if (r.exitCode === 0 && !branch) {
      const h = await git(['rev-parse', '--short', 'HEAD'])
      branch = h.exitCode === 0 ? `@${h.stdout.trim()}` : undefined
    }
  } catch {
    branch = undefined
  }
  await update($, env, prev => (prev.folder === folder && prev.path === path && prev.branch === branch ? prev : { ...prev, folder, path, branch }))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)
    await refreshEnv($).catch(() => undefined)
    const ctxPct = (await $.session.usage()).context.percent
    await update($, env, prev => ({ ...prev, ctxPct }))
    await $.tool.register({
      name: 'progress',
      description:
        'Report /savvy-flow progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light'] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For savvy-flow workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })

    // Open the agents panel by default on every session, right away.
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (!isOpen) void $.ui.open({ id: PANE, title: tr().pane })
    return started
  })

  on('command.run', { command: 'agents-info' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: 'ok' }
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!type.startsWith('savvy-')) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        parentAgentId: e.parentAgentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        steps: 0,
        round,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    if (e.subagentType.startsWith('savvy-')) {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'savvy-flow')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map(a =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running' as const,
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens: a.tokens + inputOf(usage) + (usage.output_tokens || 0),
              // The same sum split into sent and generated.
              inputTokens: (a.inputTokens ?? 0) + inputOf(usage),
              outputTokens: (a.outputTokens ?? 0) + (usage.output_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  // The header's context figure, pushed after each main-thread turn.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) await update($, env, prev => ({ ...prev, ctxPct: e.context.percent }))
    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    await refreshEnv($).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId) await refreshEnv($).catch(() => undefined)
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map(a => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? ('done' as const) : ('failed' as const),
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens: inputOf(e.usage) + e.usage.output_tokens,
                  inputTokens: inputOf(e.usage),
                  outputTokens: e.usage.output_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const where: Env = await read($, env)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    // Families, newest first; a family stays together under Running
    // while any of its runs works, then moves to Finished as a whole.
    const families = familiesOf(list).reverse()
    const runningFams = families.filter(fm => fm.isRunning)
    const finishedFams = families.filter(fm => !fm.isRunning)
    const runningRows = runningFams.flatMap(fm => fm.rows)
    const finishedRows = finishedFams.flatMap(fm => fm.rows)
    const runningCount = list.filter(a => a.status === 'running').length
    const planned = plannedOf(f, list)
    const t = totals(list, at)
    // The pane's title says "Crew Deck"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? s.expand : s.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    // A run that ended well folds itself; its arrow unfolds it. An SVG
    // takes no press, so the arrow is a one-glyph Button beside the row.
    const toggleRun = (id: string) =>
      update($, panel, prev => {
        const open = prev.expanded ?? []
        return { ...prev, expanded: open.includes(id) ? open.filter(x => x !== id) : [...open, id].slice(-200) }
      })
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finishedRows.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && planned.length === 0
    const summary = `${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      // The desktop panel never collapses: no Collapse button, and
      // Finished always shows. Each row is narrower by the arrow's slot.
      const rowW = W - ARROW_W
      const agentRow = (r: TreeRow, state: string) => {
        const isFold = isFolded(r.a, p)
        const art = <Svg source={agentSvg(rowW, r, at, bodyIndexOf(list, r.a), isFold)} alt={altOf(r, state)} width={rowW} height={rowHeight(r, isFold)} />
        return (
          <Box key={r.a.id} flexDirection="row" alignItems="center" hover={r.a.status === 'done' ? { backgroundColor: ROW_HOVER } : undefined}>
            {art}
            {r.a.status === 'done' && (
              <Button key={`fold-${r.a.id}`} label={isFold ? '▸' : '▾'} plain dimColor onPress={() => void toggleRun(r.a.id)} />
            )}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Svg
            source={headerSvg(W, title, t, where)}
            alt={[title, where.folder, where.path, where.branch, where.ctxPct === undefined ? '' : `${s.context} ${where.ctxPct}%`, summary].filter(Boolean).join(', ')}
            width={W}
            height={headerHeight(title)}
          />
          {isEmpty && (
            // The empty state takes the same air as the sections and the labels' grey.
            <Box key="empty" marginTop={1}>
              <Svg source={emptySvg(W, s.empty)} alt={s.empty} width={W} height={EMPTY_H} />
            </Box>
          )}
          {runningRows.length > 0 && (
            // The same air above Running as above Finished.
            <Box key="h-run" marginTop={1}>
              {section('h-run-text', `${s.running} · ${runningCount}`)}
            </Box>
          )}
          {runningRows.map(r => agentRow(r, r.a.status === 'running' ? s.isRunning : s.isFinished))}
          {finishedRows.length > 0 && (
            // Air above Finished, so it reads as its own group.
            <Box key="h-done" marginTop={1}>
              {section('h-done-text', `${s.finished} · ${finishedRows.length}`)}
            </Box>
          )}
          {finishedRows.map(r => agentRow(r, s.isFinished))}
          {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
          {planned.map(pl => (
            <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
          ))}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (r: TreeRow) => {
      const { a } = r
      // Tree prefix: ancestors' rails, then this run's elbow; the rows below it carry on its rail.
      const d = Math.min(r.depth, MAX_DEPTH)
      const rails = Array.from({ length: Math.max(0, d - 1) }, (_, i) => (r.rails[i + 1] ? '│ ' : '  ')).join('')
      const lead = d > 0 ? rails + (r.isLast ? '└ ' : '├ ') : ''
      const cont = d > 0 ? rails + (r.isLast ? '  ' : '│ ') : ''
      const tier = tierOf(a.type)
      const color = colorOf(tier)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={r.isGroupEnd ? 1 : 0}>
          <Box flexDirection="row" gap={1}>
            {lead ? <Text dimColor>{lead.trimEnd()}</Text> : null}
            <Text color={bodyOf(list, a)}>{d > 0 ? '▪' : '▣'}</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {cont}
            {'  '}
            {tier === 'other' ? a.type : tier} · {model}
            {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
            {r.kids > 0 ? ` · ↳ ${r.kids} ${s.sub}` : ''}
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>{cont}</Text>
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}ctx {ctx}% · {fmtTokens(a.contextTokens)} · {fmtTokens(a.tokens)} in {a.inputTokens === undefined ? '—' : fmtTokens(a.inputTokens)}{' '}
              out {a.outputTokens === undefined ? '—' : fmtTokens(a.outputTokens)} · {fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        <Text dimColor>
          {fmtCost(t.cost)} · {fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...runningRows, ...finishedRows].map(({ a }) => (
              <Text key={a.id} color={colorOf(tierOf(a.type))}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                ◷{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {runningRows.length > 0 && <Text dimColor>{s.running} · {runningCount}</Text>}
            {runningRows.map(row)}
            {finishedRows.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finishedRows.map(row)}
            {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                  <Text dimColor wrap="truncate-end">
                    <Text color={colorOf(tier)}>▢</Text> {pl.n}. {pl.title} ◷
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {tier} · {TIER_MODEL[tier] ?? ''}
                    {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    if (f === null || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const crew = list.length + plannedOf(f, list).length
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = (
      <Button key="crew-deck" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = (
      <Button
        key="crew-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    if ('Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
          {crewButton}
          {dismiss}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    return (
      <Box flexDirection="row" gap={2}>
        <Box width={titleW} flexShrink={0}>
          <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
          <Text wrap="truncate-end">{f.title}</Text>
        </Box>
        <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
        <Text bold>{label(f)}</Text>
        <Text dimColor>{percent}</Text>
        <Text color={CLAY}>▣</Text>
        {crewButton}
        {dismiss}
      </Box>
    )
  })
}
