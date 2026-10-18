import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PRICE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'

const PANE = {
  title: 'Mission Control',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

// The page's "Model pricing" table, cut down. Opus 5.5 at $7 input, not the
// built-in $4, so a cost tells which table priced it; Haiku 5.5 long at $0.60.
const PAGE = `---
title: Pricing
---

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 5.5 | $7 / MTok | $8.75 / MTok | $14 / MTok | $0.70 / MTok<sup>2</sup> | $35 / MTok |
| Claude Opus 4.1 ([retired](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Opus 4 ([retired](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.60 / MTok | $0.75 / MTok | $1.20 / MTok | $0.06 / MTok | $3 / MTok |

## Batch processing

| Model | Batch input | Batch output |
| :--- | :--- | :--- |
| Claude Opus 5.5 | $1 / MTok | $2 / MTok |
`

// Now, on the mocked clock: after PRICES was checked (2026-10-17).
const NOW = 1_792_300_000_000

// A table as `$.store` keeps it, from a fetch after PRICES was checked: Opus 5.5 at $6 input.
const STORED = {
  checkedAt: NOW - 1000,
  rows: [
    { key: 'opus-5-5', price: [6, 30, 0.6, 7.5] },
    { key: 'sonnet-5-5', price: [2, 10, 0.1, 2.5] },
    { key: 'haiku-5-5', price: [0.1, 0.5, 0.01, 0.125], long: { over: 100_000, price: [0.5, 2.5, 0.05, 0.625] } },
  ],
}

type Reply = { status: number; text: string; contentType?: string } | 'refused'

// The engine beneath `session.start`, with the page answering `reply` and the
// store holding `stored`, or failing to read when `stored` is 'broken'.
// Returns the URLs fetched and the store.
const world = (on: On, reply: Reply, stored?: unknown): { fetched: string[]; store: Map<string, unknown> } => {
  const fetched: string[] = []
  const store = new Map<string, unknown>(stored === undefined || stored === 'broken' ? [] : [['prices', stored]])
  mock.clock(on, { now: NOW })
  on('store.get', (_, e) => (stored === 'broken' ? { deny: 'store unreadable' } : { value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  mock.env(on, { HOME: '/home/me' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/home/me/repo' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('tool.register', () => ({ value: { tool: 'mcp__mission-control__step' } }))
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    if (reply === 'refused') return { deny: 'refused by policy' }
    return {
      value: {
        status: reply.status,
        ok: reply.status >= 200 && reply.status < 300,
        headers: { 'content-type': reply.contentType ?? 'text/markdown; charset=utf-8' },
        text: reply.text,
      },
    }
  })
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-opus-5-5' }))
  on('turn.complete', () => ({ text: 'Done' }))
  return { fetched, store }
}

// The kit resolves once the price load, which the start leaves unawaited, settled.
const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/home/me/repo', surface: null, isInteractive: true })
}

// One subagent that sends `input` uncached tokens to `model` and ends: the
// cost its row shows.
const costOf = async ($: Engine, model: string, input: number): Promise<string | undefined> => {
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Map the code',
    description: 'Map the code',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await $.turn.complete({
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
    answer: 'Done',
    durationMs: 1000,
    isAborted: false,
    usage: { model, input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'desktop', component: 'Pane', requestId: 'mission-control', props: PANE })
  const rows = await ui.findAll({ type: 'Svg' })
  await ui.unmount()
  const alt = rows.map(r => String(r.props.alt)).find(a => a.includes('Map the code'))
  return /\$\d+\.\d+/.exec(alt ?? '')?.[0]
}

test('a valid page prices the runs and is kept for later sessions', async ($, on) => {
  const { fetched, store } = world(on, { status: 200, text: PAGE })
  await start($)

  expect(fetched).toEqual([PRICE_URL])
  expect(await costOf($, 'claude-opus-5-5-20261001', 1_000_000)).toBe('$7.00')
  expect(store.get('prices')).toEqual(expect.objectContaining({ rows: expect.arrayContaining([{ key: 'opus-5-5', price: [7, 35, 0.7, 8.75] }]) }))
})

test("the page's upper tier prices a long prompt", async ($, on) => {
  world(on, { status: 200, text: PAGE })
  await start($)

  // 200k tokens past the 100k line: $0.60, not the built-in $0.50.
  expect(await costOf($, 'claude-haiku-5-5', 200_000)).toBe('$0.12')
})

test('a model the page does not list takes the built-in price', async ($, on) => {
  world(on, { status: 200, text: PAGE })
  await start($)

  // Sonnet 5 is not on the cut-down page: built-in $2 input.
  expect(await costOf($, 'claude-sonnet-5', 1_000_000)).toBe('$2.00')
})

test('a failed fetch falls back to the last valid one', async ($, on) => {
  world(on, { status: 500, text: 'oops' }, STORED)
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$6.00')
})

test('a refused fetch falls back to the built-in prices', async ($, on) => {
  world(on, 'refused')
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('a page out of order is discarded whole', async ($, on) => {
  // Cache hits above the base input: no Claude price looks like that.
  const { store } = world(on, { status: 200, text: PAGE.replace('$0.70 / MTok<sup>2</sup>', '$70 / MTok') }, STORED)
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$6.00')
  expect(store.get('prices')).toEqual(STORED)
})

test('a page with an unreadable price is discarded whole', async ($, on) => {
  const { store } = world(on, { status: 200, text: PAGE.replace('$2 / MTok |', 'two dollars |') })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
  expect(store.get('prices')).toBeUndefined()
})

test('a page without the table is discarded', async ($, on) => {
  world(on, { status: 200, text: '<html><body>Moved</body></html>' })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('a page that is not text is discarded', async ($, on) => {
  world(on, { status: 200, text: PAGE, contentType: 'application/octet-stream' })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('a page far too large is discarded', async ($, on) => {
  world(on, { status: 200, text: PAGE + ' '.repeat(600_000) })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('a page missing a family is discarded', async ($, on) => {
  world(on, { status: 200, text: PAGE.split('\n').filter(l => !l.includes('Haiku')).join('\n') })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('a damaged store and a failed fetch fall back to the built-in prices', async ($, on) => {
  world(on, { status: 503, text: '' }, { checkedAt: 1, rows: [{ key: 'opus-5-5', price: [0, 0, 0, 0] }] })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('a fetched page wins over the stored table', async ($, on) => {
  const { store } = world(on, { status: 200, text: PAGE }, STORED)
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$7.00')
  expect(store.get('prices')).toEqual(expect.objectContaining({ checkedAt: NOW }))
})

test('an unreadable store still lets the page through', async ($, on) => {
  const { fetched } = world(on, { status: 200, text: PAGE }, 'broken')
  await start($)

  expect(fetched).toEqual([PRICE_URL])
  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$7.00')
})

test('a stored table older than the built-in prices loses to them', async ($, on) => {
  world(on, { status: 500, text: '' }, { ...STORED, checkedAt: 1 })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('a page without the Haiku 5.5 long tier is discarded', async ($, on) => {
  const flat = PAGE.split('\n')
    .filter(l => !l.includes('prompts over'))
    .join('\n')
    .replace('Claude Haiku 5.5 (for prompts up to 100,000 tokens)', 'Claude Haiku 5.5')
  const { store } = world(on, { status: 200, text: flat })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
  expect(store.get('prices')).toBeUndefined()
})

test('a page listing a model twice is discarded', async ($, on) => {
  const twice = PAGE.replace(/(\| Claude Sonnet 5\.5 .*\n)/, '$1$1')
  world(on, { status: 200, text: twice })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('a page with far too many rows is discarded', async ($, on) => {
  // Rows the parser skips, so only their number can discard the page.
  const row = '| Other model | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |\n'
  world(on, { status: 200, text: PAGE.replace('\n\n## Batch processing', '\n' + row.repeat(300) + '\n## Batch processing') })
  await start($)

  expect(await costOf($, 'claude-opus-5-5', 1_000_000)).toBe('$4.00')
})

test('the alias claude-opus-4-0 takes the page row of Opus 4', async ($, on) => {
  world(on, { status: 200, text: PAGE })
  await start($)

  expect(await costOf($, 'claude-opus-4-0', 1_000_000)).toBe('$15.0')
})
