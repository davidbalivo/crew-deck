import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { AgentRun, AgentStatus, Env, Limit, Main, Panel } from '../types'

const agents = atom({ plugin: 'crew-deck', key: 'agents' } as const, [])
const panel = atom({ plugin: 'crew-deck', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  expanded: [],
})
const now = atom({ plugin: 'crew-deck', key: 'now' } as const, 0)
// Where the session works (folder, its parent, git branch), for the header.
const env = atom({ plugin: 'crew-deck', key: 'env' } as const, { folder: '', path: '' } as Env)
// The main thread's model, context and own usage, for its section.
const main = atom({ plugin: 'crew-deck', key: 'main' } as const, {
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  limits: [],
})

const STEP_TOOL = 'mcp__crew-deck__step'
const PANE = 'crew-deck'

// ---------------------------------------------------------------------------
// The panel's words.

const S = {
  pane: 'Crew Deck',
  repo: 'Repo',
  mainThread: 'Main thread',
  subagents: 'Subagents',
  context: 'Context',
  cost: 'Cost',
  tokens: 'Tokens',
  time: 'Time',
  collapse: 'Collapse',
  expand: 'Expand',
  running: 'Running',
  finished: 'Finished',
  empty: 'No subagents yet',
  round: 'round',
  failed: 'error',
  tokensWord: 'tokens',
  isRunning: 'running',
  isFinished: 'finished',
  isFailed: 'failed',
  isStopped: 'stopped',
  stopping: 'stopping',
  confirmStop: 'press ■ again to stop',
  agent: 'agent',
  agents: 'agents',
  opened: 'opened',
  closed: 'closed',
  sub: 'sub',
} as const

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56

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

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session.

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

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// ---------------------------------------------------------------------------
// The tree of spawns. `agent.spawn` records the loop each run was
// spawned from; a run whose parent is not in the list (main thread, trimmed)
// is a root. A family is a root and all its descendants.

const MAX_DEPTH = 3
const INDENT = 18
const RAIL_OFFSET = 10

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

type Family = { rows: TreeRow[]; isRunning: boolean }

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
      return [{ rows, isRunning: rows.some(x => x.a.status === 'running') }]
    })
  const out = families(roots)
  return [...out, ...families(list.filter(a => !seen.has(a.id)))]
}

// --- desktop drawings: each row is one SVG.

// Palette from the redesign research (Few, Carbon, Okabe-Ito, WCAG):
// grey text in three steps, one hue per state, every color with a dark variant.
// Text passes 4.5:1 and marks 3:1 on #FFFFFF / #1F1F1E. `.cR` running, `.cF`
// failed, `.cG` `.cW` `.cO` `.cF` the header's context by level (green, amber,
// orange, red), `.bf` an agent's body (`--b`), `.card` the usage card's soft fill.
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
.t{fill:#1F1F1E}.s{fill:#55544F}.m{fill:#73726D}.k{fill:#E6E5E1}.ln{stroke:#ECEBE7}.tile{fill:#F4F3F0}.card{fill:#F5F4F1}.tr{stroke:#D3D2CD;stroke-width:1.2;fill:none;stroke-linecap:round}
.mvC{fill:#2B6A62}.ml{fill:#73726D}.mk{fill:#A3A29C}
.cR{fill:#B5532F}.cF{fill:#C42B2B}.cW{fill:#9A5B00}.cG{fill:#2E7D52}.cO{fill:#B34E00}.sF{stroke:#C42B2B}.sM{stroke:#73726D}.bf{fill:var(--b)}${bodyCss(0)}
@media (prefers-color-scheme: dark){.t{fill:#ECEBE8}.s{fill:#BDBCB6}.m{fill:#97968F}.k{fill:#3A3A37}.ln{stroke:#2E2E2C}.tile{fill:#262625}.card{fill:#2A2A28}.tr{stroke:#4A4A47}
.mvC{fill:#8FC8BF}.ml{fill:#97968F}.mk{fill:#6C6B66}
.cR{fill:#E08A6B}.cF{fill:#F2726B}.cW{fill:#E8A33D}.cG{fill:#5DBE8A}.cO{fill:#F08A4B}.sF{stroke:#F2726B}.sM{stroke:#97968F}${bodyCss(1)}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid. Explore
// runs wear a pirate costume; every other run is the bare crab.
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
type Costume = 'explore' | 'other'

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
// a costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<Costume, (f: Fill) => void> = {
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f, BODY)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f, BODY),
}

const costumeOf = (type: string): Costume => (type === 'Explore' ? 'explore' : 'other')

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: Costume, isWalking: boolean, scale: number): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    const paint = c === BODY ? 'class="bf"' : `fill="${c}"`
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" ${paint}/>`)
  }
  COSTUMES[costume](f)
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

// A run still working shows its stop button in the slot, a finished one its
// fold arrow; the others draw their mark there: failed a red cross, stopped a
// grey square.
const statusMark = (x: number, y: number, status: 'failed' | 'stopped'): string =>
  status === 'failed'
    ? `<path class="sF" d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke-width="1.8" stroke-linecap="round"/>`
    : `<rect class="m" x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1.5"/>`

// Runs whose slot holds a Button beside the drawing: the stop, or the fold arrow.
const hasSlotButton = (a: AgentRun): boolean => a.status === 'running' || a.status === 'done'

// What a run says it is, for a screen reader.
const stateOf = (a: AgentRun): string =>
  a.status === 'running' ? (a.isStopRequested ? S.stopping : S.isRunning) : a.status === 'stopped' ? S.isStopped : a.status === 'failed' ? S.isFailed : S.isFinished

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title says "Crew Deck". The header has two bands. Above, the
// folder, its parent path and the git branch in a pill; below, context, tokens,
// cost and time, each value under its label, the last three on the agent rows'
// metric columns. Only the cost and the context carry color and weight.
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

// The main thread's context figure and bar change color as it fills up:
// green below 40%, amber below 50%, orange below 60%, red from there.
const ctxLevel = (pct: number): string => (pct < 40 ? 'cG' : pct < 50 ? 'cW' : pct < 60 ? 'cO' : 'cF')

// A rate-limit window grey until 80%, orange until 95%, red from there.
const limitLevel = (pct: number): string => (pct < 80 ? 'ml' : pct < 95 ? 'cO' : 'cF')

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// The windows the section shows, in a fixed order, at most two.
const limitsOf = (list: readonly Limit[]): { label: string; pct: number }[] =>
  Object.entries(LIMIT_LABEL)
    .flatMap(([kind, label]) => {
      const l = list.find(x => x.kind === kind)
      return l ? [{ label, pct: Math.round(l.pct) }] : []
    })
    .slice(0, 2)

// A window size reads `1M`, not `1.0M`.
const fmtWindow = (n: number): string => (n >= 1e6 && n % 1e6 === 0 ? `${n / 1e6}M` : fmtTokens(n))

const svgText = (x: number, y: number, size: number, cls: string, body: string, extra = ''): string =>
  `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-variant-numeric="tabular-nums"${extra}>${body}</text>`
const END = ' text-anchor="end"'
const BOLD = ' font-weight="600"'
// Bold runs ~6% wider than the estimate.
const boldWidth = (s: string, size: number): number => textWidth(s, size) * HEADER_BOLD

// A section's title: 10 px capitals, tracked, bold, in the `.m` grey, so it
// reads apart from the 11 px column labels.
const TITLE_TRACKING = 0.8
const sectionTitle = (x: number, y: number, title: string): string =>
  svgText(x, y, 10, 'm', xml(title.toUpperCase()), `${BOLD} letter-spacing="${TITLE_TRACKING}"`)
const titleWidth = (title: string): number => boldWidth(title.toUpperCase(), 10) + TITLE_TRACKING * title.length

// One figure of a row: its width and its markup, drawn at a given x.
type Figure = { w: number; body: string }

// A grey figure with its word in the lighter `ctx` grey, before or after it.
const labelled = (value: string, word: string, side: 'before' | 'after' = 'before', size = SIZE): Figure => ({
  w: textWidth(`${word} ${value}`, size),
  body:
    side === 'before'
      ? `<tspan class="mk">${xml(word)}</tspan> <tspan class="ml">${xml(value)}</tspan>`
      : `<tspan class="ml">${xml(value)}</tspan> <tspan class="mk">${xml(word)}</tspan>`,
})

// Figures in a row from x = 0, FIGURE_GAP apart. A group that does not fit in
// `maxW` is left out whole, and so are the ones after it.
const FIGURE_GAP = 20
const spaced = (groups: Figure[][], maxW: number, y: number, size = SIZE): string => {
  const out: string[] = []
  let x = 0
  for (const group of groups) {
    const gaps = out.length ? group.length : group.length - 1
    const w = group.reduce((sum, f) => sum + f.w, 0) + FIGURE_GAP * gaps
    if (x + w > maxW) break
    for (const f of group) {
      if (out.length) x += FIGURE_GAP
      out.push(svgText(Math.round(x), y, size, 'ml', f.body))
      x += f.w
    }
  }
  return out.join('')
}

// The header: the repo on top, the session's usage in one card below.
// Top line: the folder, its parent path and the git branch in a pill, with no
// title. Below it a soft card holds the usage in two sections, Main thread and
// Subagents, each under its title; the card starts in this SVG and ends in the
// subagents' one, stacked right under it. Right of the time column the rows
// keep room for their status mark and fold arrow (ARROW_W + ROW_GAP); the card
// takes that room as its right margin outside plus PAD inside, and mirrors both
// on the left, so the right side keeps the agent rows' columns.
// Main thread: two rows mirrored around the context bar. On the left the model
// over the cost and tokens; on the right two columns that share the agent rows'
// cost and time edges: the context percentage over one limit, the context
// tokens over the other. Everything ends on the time column.
const PAD = 12
// A function, not a constant: ARROW_W and ROW_GAP are declared further down.
const cardInset = (): number => ARROW_W + ROW_GAP - PAD
const CARD_R = 8
const TITLE_GAP = 25
const SECTION_GAP = 44
const Y_ID = 22
const CARD_TOP = 40
// Air inside the card above its first title and below its last figures,
// and below the card before the agent list.
const CARD_PAD_TOP = 32
const CARD_PAD_BOTTOM = 24
const CARD_GAP_BELOW = 16
const Y_TITLE = CARD_TOP + CARD_PAD_TOP
const Y_ROW1 = Y_TITLE + TITLE_GAP
const BAR_Y = Y_ROW1 + 9
const BAR_H = 4
const Y_ROW2 = BAR_Y + BAR_H + 9 + 9
const HEADER_H = Y_ROW2 + 12
const SIZE = 12
const SIZE_KEY = 13

const headerSvg = (W: number, where: Env, m: Main): string => {
  const [, c2, c3] = rowEdges(W)
  const cx = cardInset()
  // The card's right edge, cx from the panel's, as on the left.
  const cardW = W - cx
  const x0 = cx + PAD

  // Repo: folder, then its parent path, then the branch pill ending on the time column.
  // The folder starts at x0, on the card's titles.
  let pill = ''
  let pillX = c3
  if (where.branch) {
    const maxText = Math.max(30, W * 0.4 - 26)
    let branch = where.branch
    while (branch.length > 2 && monoWidth(branch, 11) > maxText) branch = branch.slice(0, -2) + '…'
    const pw = Math.round(26 + monoWidth(branch, 11))
    pillX = c3 - pw
    pill =
      `<rect class="tile" x="${pillX}" y="${Y_ID - 11}" width="${pw}" height="18" rx="6"/>${BRANCH_ICON(pillX + 6, Y_ID - 8)}` +
      `<text class="s" x="${pillX + 20}" y="${Y_ID + 2}" font-family="${MONO}" font-size="11">${xml(branch)}</text>`
  }
  const folder = fitText(where.folder || '—', 14, Math.max(40, pillX - x0 - 12 - 60))
  const pathX = Math.round(x0 + textWidth(folder, 14) * 1.04 + 6)
  const pathW = pillX - 12 - pathX
  const path = where.path && pathW > 30 ? svgText(pathX, Y_ID, 11, 'm', xml(fitMiddle(where.path, 11, pathW))) : ''

  // Main thread. Both left lines stop at the same edge, clear of the cost column's figures.
  const leftW = Math.max(0, c2 - x0 - Math.max(boldWidth('100%', SIZE_KEY), textWidth('spend 100%', SIZE)) - 16)
  // The model in the row's grey, its effort in the lighter one; the effort goes first when room runs out.
  const name = m.model ? modelName(m.model) : '—'
  const effort = m.model && m.effort ? ` · ${m.effort}` : ''
  const model =
    effort && textWidth(name + effort, SIZE) <= leftW
      ? `${xml(name)}<tspan class="mk">${xml(effort)}</tspan>`
      : xml(fitText(name, SIZE, leftW))
  const pct = m.ctxPct ?? 0
  const pctClass = ctxLevel(pct)
  const ctxTokens = m.ctxWindow
    ? `<tspan class="ml">${xml(fmtTokens(m.ctxTokens ?? 0))}</tspan><tspan class="mk"> / ${xml(fmtWindow(m.ctxWindow))}</tspan>`
    : ''
  const barW = c3 - x0
  const fill = Math.round((barW * Math.min(100, pct)) / 100)

  // Row 2, left: the cost, then the tokens, then sent and generated; a group
  // that does not fit is left out whole, the last first.
  const cost = fmtCost(m.costUsd)
  const figures = spaced(
    [
      [{ w: boldWidth(cost, SIZE_KEY), body: `<tspan class="mvC" font-size="${SIZE_KEY}" font-weight="600">${xml(cost)}</tspan>` }],
      [labelled(fmtTokens(m.tokens), S.tokensWord, 'after')],
      [labelled(fmtTokens(m.inputTokens), 'in'), labelled(fmtTokens(m.outputTokens), 'out')],
    ],
    leftW,
    Y_ROW2,
  )

  // Row 2, right: the limits on the time column, then the cost column.
  const limits = limitsOf(m.limits)
    .reverse()
    .map((l, i) =>
      svgText(i === 0 ? c3 : c2, Y_ROW2, SIZE, 'ml', `<tspan class="mk">${l.label}</tspan> <tspan class="${limitLevel(l.pct)}">${l.pct}%</tspan>`, END),
    )
    .join('')

  return svg(
    W,
    HEADER_H,
    `${svgText(x0, Y_ID, 14, 'ml', xml(folder), BOLD)}${path}${pill}
<path class="card" d="M${cx} ${CARD_TOP + CARD_R}a${CARD_R} ${CARD_R} 0 0 1 ${CARD_R} -${CARD_R}H${cardW - CARD_R}a${CARD_R} ${CARD_R} 0 0 1 ${CARD_R} ${CARD_R}V${HEADER_H}H${cx}Z"/>
${sectionTitle(x0, Y_TITLE, S.mainThread)}
${svgText(x0, Y_ROW1, SIZE, 's', model)}
${svgText(c2, Y_ROW1, SIZE_KEY, pctClass, `${pct}%`, END + BOLD)}${ctxTokens ? svgText(c3, Y_ROW1, SIZE, 'ml', ctxTokens, END) : ''}
<rect class="k" x="${x0}" y="${BAR_Y}" width="${barW}" height="${BAR_H}" rx="${BAR_H / 2}"/><rect class="${pctClass}" x="${x0}" y="${BAR_Y}" width="${fill}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g transform="translate(${x0},0)">${figures}</g>
${limits}`,
  )
}

// The subagents' sums, the card's second section: the title SECTION_GAP below
// the main thread's last row, with the column labels on its line while 24 px
// stay between them, else LABELS_DROP lower; the values TITLE_GAP below the
// labels, on the agent rows' columns; then the card's rounded bottom. Left of
// the values, how many runs there are, then how many still work and how many
// failed. Figures take the main thread's sizes: SIZE, and SIZE_KEY for the cost.
const SUB_TITLE = Y_ROW2 + SECTION_GAP - HEADER_H
const LABELS_DROP = 19
const labelsDrop = (W: number): number => {
  const [c1] = rowEdges(W)
  return cardInset() + PAD + titleWidth(S.subagents) + 24 <= c1 - textWidth(S.tokens, 11) ? 0 : LABELS_DROP
}
const cardBottom = (W: number): number => SUB_TITLE + labelsDrop(W) + TITLE_GAP + CARD_PAD_BOTTOM
const subagentsHeight = (W: number): number => cardBottom(W) + CARD_GAP_BELOW
const subagentsSvg = (W: number, t: ReturnType<typeof totals>, list: readonly AgentRun[]): string => {
  const [c1, c2, c3] = rowEdges(W)
  const H = subagentsHeight(W)
  const bottom = cardBottom(W)
  const yLab = SUB_TITLE + labelsDrop(W)
  const yVal = yLab + TITLE_GAP
  const cx = cardInset()
  // The card's right edge, cx from the panel's, as on the left.
  const cardW = W - cx
  const x0 = cx + PAD
  const running = list.filter(a => a.status === 'running').length
  const failed = list.filter(a => a.status === 'failed').length
  const tokens = fmtTokens(t.tokens)
  // A failed count keeps the red of the failed mark.
  const failedFigure: Figure = {
    w: textWidth(`${failed} ${S.isFailed}`, SIZE),
    body: `<tspan class="cF">${failed}</tspan> <tspan class="mk">${S.isFailed}</tspan>`,
  }
  const counts = spaced(
    [
      [labelled(String(list.length), list.length === 1 ? S.agent : S.agents, 'after')],
      running ? [labelled(String(running), S.isRunning, 'after')] : [],
      failed ? [failedFigure] : [],
    ].filter(g => g.length),
    c1 - x0 - textWidth(tokens, SIZE) - 16,
    yVal,
  )
  return svg(
    W,
    H,
    `<path class="card" d="M${cx} 0H${cardW}V${bottom - CARD_R}a${CARD_R} ${CARD_R} 0 0 1 -${CARD_R} ${CARD_R}H${cx + CARD_R}a${CARD_R} ${CARD_R} 0 0 1 -${CARD_R} -${CARD_R}Z"/>
${sectionTitle(x0, SUB_TITLE, S.subagents)}
${svgText(c1, yLab, 11, 'mk', S.tokens, END)}${svgText(c2, yLab, 11, 'mk', S.cost, END)}${svgText(c3, yLab, 11, 'mk', S.time, END)}
<g transform="translate(${x0},0)">${counts}</g>${svgText(c1, yVal, SIZE, 'ml', xml(tokens), END)}${svgText(c2, yVal, SIZE_KEY, 'mvC', xml(fmtCost(t.cost)), END + BOLD)}${svgText(c3, yVal, SIZE, 'ml', xml(fmtTime(t.time)), END)}`,
  )
}

// A line of the list in 11 px and the `.mk` grey of `ctx`, `in` and `out`:
// "No subagents yet", and the "Running · n" and "Finished · n" labels. Drawn,
// not a dim Text, so the grey is ours and not the surface's.
const NOTE_H = 18
const noteSvg = (W: number, text: string): string =>
  svg(W, NOTE_H, `<text class="mk" x="0" y="13" font-family="${FONT}" font-size="11">${xml(text)}</text>`)

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
// The slot right of each desktop row's time column: a finished run's fold
// arrow, or the status mark of a run still working or failed. ROW_GAP keeps it
// clear of the time column.
const ARROW_W = 16
const ROW_GAP = 4
// The metric columns of the rows, and of the header above them, from the pane's width.
const rowEdges = (W: number): [number, number, number] => metricEdges(W - ARROW_W - ROW_GAP)
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
  `${r.depth > 0 ? '↳ ' : ''}${r.a.description || r.a.type}: ${modelName(r.a.model)}, ${state}${r.kids > 0 ? `, ${r.kids} ${S.sub}` : ''}` +
  // A folded row still says its cost and tokens to a screen reader.
  `, ${fmtCost(r.a.costUsd)}, ${fmtTokens(r.a.tokens)} ${S.tokensWord}`

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
const agentSvg = (W: number, row: TreeRow, at: number, bodyIdx: number, isFold = false, isArmed = false): string => {
  const { a } = row
  const d = Math.min(row.depth, MAX_DEPTH)
  const isSub = d > 0
  const ind = d * INDENT
  const g = geomOf(row, isFold)
  const { H, scale: sc } = g
  const crabY = crabTop(H, sc)
  const x0 = ind + g.textX
  const [c1, c2, c3] = rowEdges(W)
  // A run with a Button in the slot leaves it to the Button, beside the drawing.
  const svgW = hasSlotButton(a) ? W - ARROW_W : W
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
  const crabSvg = `<g class="b${bodyIdx}">${crab(ind, crabY, costumeOf(a.type), a.status === 'running', sc)}</g>`
  const groupEnd = row.isGroupEnd ? `<line class="ln" x1="0" y1="${H - 0.5}" x2="${W - ARROW_W}" y2="${H - 0.5}"/>` : ''
  const mark = a.status === 'failed' || a.status === 'stopped' ? statusMark(W - ARROW_W / 2, Math.round(H / 2), a.status) : ''

  if (isFold) {
    const [y] = baselines(H, 1, 0)
    const size = isSub ? 11 : 12
    const titleW = Math.max(0, c2 - METRIC_COLS[1] - x0 - 12)
    return svg(
      svgW,
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
  if (a.round > 1) meta.push(`${S.round} ${a.round}`)
  if (row.kids > 0) meta.push(`↳ ${row.kids} ${S.sub}`)
  // The run's end, when it is not a plain finish: a failure in red, a stop in grey.
  const [tail, tailCls] =
    a.status === 'failed'
      ? [` · ${S.failed}`, 'cF']
      : a.status === 'stopped'
        ? [` · ${S.isStopped}`, 'm']
        : a.isStopRequested
          ? [` · ${S.stopping}…`, 'm']
          : isArmed
            ? [` · ${S.confirmStop}`, 'cF']
          : ['', '']
  const metaRich =
    xml(fitText(meta.join(' · '), 11, Math.max(0, metaW - textWidth(tail, 11)))) + (tail ? `<tspan class="${tailCls}" font-weight="600">${xml(tail)}</tspan>` : '')

  let line3 = ''
  if (a.stepTotal) {
    const total = a.stepTotal
    const done = a.stepDone ?? 0
    const count = `${done}/${total}`
    const [, bw] = stepBlocks(0, 0, done, total)
    // The steps come first in priority: the type gets what they leave.
    const stepsW = textWidth(count, 11) + 6 + bw
    const typeRoom = leftW - stepsW - 10
    const typeText = typeRoom >= 30 ? fitText(a.type, 11, typeRoom) : ''
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
    line3 = text(x0, l3, 11, 'mk', xml(fitText(a.type, 11, leftW)))
  }

  return svg(
    svgW,
    H,
    `${lines.join('')}${crabSvg}
${text(x0, l1, titleSize, 't', xml(fitText(a.description || a.type, titleSize, titleW)), ' font-weight="600"')}
${text(x0, l2, 11, 's', metaRich)}
${line3}
${metrics}
${mark}${groupEnd}`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<AgentStatus, string> = { running: '●', done: '✓', failed: '✗', stopped: '■' }

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: S.pane })
  return true
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

const mainModel = (m: Main): string => (m.model ? (m.effort ? `${modelName(m.model)} · ${m.effort}` : modelName(m.model)) : '—')

// The main thread's section in words: for a screen reader and the terminal.
const mainSummary = (m: Main): string[] => [
  `${S.context} ${m.ctxPct ?? 0}%${m.ctxWindow ? ` ${fmtTokens(m.ctxTokens ?? 0)} / ${fmtWindow(m.ctxWindow)}` : ''}`,
  `${fmtCost(m.costUsd)} · ${fmtTokens(m.tokens)} ${S.tokensWord} · in ${fmtTokens(m.inputTokens)} out ${fmtTokens(m.outputTokens)}`,
  ...limitsOf(m.limits).map(l => `${l.label} ${l.pct}%`),
]

// The main thread's context and the account's limits, as the engine measured them.
const measured = (prev: Main, u: Pick<SessionUsage, 'context' | 'rateLimits'>): Main => ({
  ...prev,
  ctxTokens: u.context.tokens,
  ctxWindow: u.context.window,
  ctxPct: u.context.percent,
  limits: u.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed })),
})

// The stop: what a stopped run answers, how long a first press stays armed.
const STOP_ANSWER = 'Stopped by the person from the Crew Deck panel before finishing.'
const ARM_MS = 4000

const isStopRequested = async ($: EngineInterface, agentId: string): Promise<boolean> =>
  (await read($, agents)).some(a => a.agentId === agentId && a.isStopRequested === true)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refreshEnv($).catch(() => undefined)
    const usage = await $.session.usage()
    // The model before the first response; each request names it from then on.
    const model = await $.session.model()
    await update($, main, prev => ({ ...measured(prev, usage), model }))
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the Crew Deck panel. ' +
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
      name: 'crew-deck',
      description: 'Show or hide Crew Deck: the session and its subagents, with model, context, cost and time',
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
    if (!isOpen) void $.ui.open({ id: PANE, title: S.pane })
    return started
  })

  on('command.run', { command: 'crew-deck' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? S.opened : S.closed }
  })

  // A stopped run's tool calls are refused while its last model request ends.
  on('tool.call', async ($, e, next) => {
    if (e.agentId && (await isStopRequested($, e.agentId))) return { deny: STOP_ANSWER }
    return next(e)
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
    return started
  })

  // Each model request: a subagent's live context, tokens and cost, or the
  // main thread's model, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    // A run stopped from the panel asks for nothing more: its turn ends here,
    // and the agent that spawned it reads STOP_ANSWER as its answer.
    if (e.agentId && (await isStopRequested($, e.agentId))) {
      return { turnId: e.turnId, index: e.index, answer: STOP_ANSWER, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!usage) return result

    const model = usage.model || e.model
    if (!agentId) {
      await update($, main, prev => ({
        ...prev,
        model,
        effort: typeof e.effort === 'string' ? e.effort : prev.effort,
        tokens: prev.tokens + inputOf(usage) + (usage.output_tokens || 0),
        inputTokens: prev.inputTokens + inputOf(usage),
        outputTokens: prev.outputTokens + (usage.output_tokens || 0),
        costUsd: prev.costUsd + costOf(model, usage),
      }))
      return result
    }
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

  // The main thread's context and the account's limits, pushed after each main-thread turn.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context') || e.changed.includes('rateLimits')) await update($, main, prev => measured(prev, e))
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
            status: a.isStopRequested ? ('stopped' as const) : e.reason === 'answer' ? ('done' as const) : ('failed' as const),
            // The stop ends with the turn: a run its parent resumes later works again.
            isStopRequested: undefined,
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
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const p: Panel = await read($, panel)
    const where: Env = await read($, env)
    const m: Main = await read($, main)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    // Families, newest first; a family stays together under Running
    // while any of its runs works, then moves to Finished as a whole.
    const families = familiesOf(list).reverse()
    const runningFams = families.filter(fm => fm.isRunning)
    const finishedFams = families.filter(fm => !fm.isRunning)
    const runningRows = runningFams.flatMap(fm => fm.rows)
    const finishedRows = finishedFams.flatMap(fm => fm.rows)
    const runningCount = list.filter(a => a.status === 'running').length
    const t = totals(list, at)

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? S.expand : S.collapse}
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
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${S.finished} · ${finishedRows.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0
    const summary = `${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${S.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => <Svg key={key} source={noteSvg(W, text)} alt={text} width={W} height={NOTE_H} />

      // The desktop panel never collapses: no Collapse button, and
      // Finished always shows. A run still working or finished has a Button in
      // the slot right of its drawing: the stop, or the fold arrow; the others
      // draw their status mark there.
      // The stop takes two presses: the first arms it for ARM_MS (the square at
      // full strength, the row asking for a second press in red), the second
      // stops the run. A Button takes a label only, no colored child. A run
      // already stopping shows a dim square that takes no press.
      const isArmed = (a: AgentRun): boolean => p.armedStop?.id === a.id && at - p.armedStop.at < ARM_MS
      const stopSlot = (a: AgentRun) => {
        if (a.isStopRequested) return <Text key={`stop-${a.id}`} dimColor>■</Text>
        if (isArmed(a)) {
          const stop = () =>
            Promise.all([
              update($, agents, rows => rows.map(x => (x.id === a.id ? { ...x, isStopRequested: true } : x))),
              update($, panel, prev => ({ ...prev, armedStop: undefined })),
            ])
          return (
<Button key={`stop-${a.id}`} label="■" plain onPress={() => void stop()} />
          )
        }
        const arm = async () => {
          const armedAt = await $.clock.now()
          await update($, now, () => armedAt)
          await update($, panel, prev => ({ ...prev, armedStop: { id: a.id, at: armedAt } }))
        }
        return (
<Button key={`stop-${a.id}`} label="■" plain dimColor onPress={() => void arm()} />
        )
      }
      const agentRow = (r: TreeRow) => {
        const isFold = isFolded(r.a, p)
        const art = <Svg source={agentSvg(W, r, at, bodyIndexOf(list, r.a), isFold, isArmed(r.a))} alt={altOf(r, stateOf(r.a))} width={hasSlotButton(r.a) ? W - ARROW_W : W} height={rowHeight(r, isFold)} />
        return (
          <Box key={r.a.id} flexDirection="row" alignItems="center" hover={r.a.status === 'done' ? { backgroundColor: ROW_HOVER } : undefined}>
            {art}
            {r.a.status === 'done' && (
              <Button key={`fold-${r.a.id}`} label={isFold ? '▸' : '▾'} plain dimColor onPress={() => void toggleRun(r.a.id)} />
            )}
            {r.a.status === 'running' && stopSlot(r.a)}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Svg
            source={headerSvg(W, where, m)}
            alt={[`${S.repo}: ${where.folder}`, where.path, where.branch, `${S.mainThread}: ${mainModel(m)}`, ...mainSummary(m)].filter(Boolean).join(', ')}
            width={W}
            height={HEADER_H}
          />
          <Svg source={subagentsSvg(W, t, list)} alt={`${S.subagents}: ${summary}`} width={W} height={subagentsHeight(W)} />
          {isEmpty && (
            // The empty state takes the same air as the sections and the labels' grey.
            <Box key="empty" marginTop={1}>
              <Svg source={noteSvg(W, S.empty)} alt={S.empty} width={W} height={NOTE_H} />
            </Box>
          )}
          {runningRows.length > 0 && (
            // The same air above Running as above Finished.
            <Box key="h-run" marginTop={1}>
              {section('h-run-text', `${S.running} · ${runningCount}`)}
            </Box>
          )}
          {runningRows.map(agentRow)}
          {finishedRows.length > 0 && (
            // Air above Finished, so it reads as its own group.
            <Box key="h-done" marginTop={1}>
              {section('h-done-text', `${S.finished} · ${finishedRows.length}`)}
            </Box>
          )}
          {finishedRows.map(agentRow)}
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
      const color = bodyOf(list, a)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={r.isGroupEnd ? 1 : 0}>
          <Box flexDirection="row" gap={1}>
            {lead ? <Text dimColor>{lead.trimEnd()}</Text> : null}
            <Text color={color}>{d > 0 ? '▪' : '▣'}</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : a.status === 'stopped' ? 'gray' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {cont}
            {'  '}
            {a.type} · {model}
            {a.round > 1 ? ` · ${S.round} ${a.round}` : ''}
            {r.kids > 0 ? ` · ↳ ${r.kids} ${S.sub}` : ''}
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
        <Text dimColor>{S.mainThread}</Text>
        <Text wrap="truncate-end">{mainModel(m)}</Text>
        <Text dimColor wrap="truncate-end">
          {mainSummary(m).join(' · ')}
        </Text>
        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {S.subagents} · {fmtCost(t.cost)} · {fmtTokens(t.tokens)} {S.tokensWord} · {fmtTime(t.time)}
          </Text>
          {toggleCompact}
        </Box>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...runningRows, ...finishedRows].map(({ a }) => (
              <Text key={a.id} color={bodyOf(list, a)}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{S.empty}</Text>}
            {runningRows.length > 0 && <Text dimColor>{S.running} · {runningCount}</Text>}
            {runningRows.map(row)}
            {finishedRows.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finishedRows.map(row)}
          </Box>
        )}
      </Box>
    )
  })
}
