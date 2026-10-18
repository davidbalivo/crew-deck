import { expect, mock, test } from 'claude-code/testing'
import type { RenderChildren } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  title: 'Crew Deck',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

// Starts one subagent through the plugin's `agent.spawn` hook; the test's own
// hook stands for the engine and names it `a1`.
const spawnRun = async ($: Engine): Promise<void> => {
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
}

// The handle the host holds for the Button under `key`, as the page gets it.
const handleOf = (node: RenderChildren, key: string): number | undefined => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const h = handleOf(child, key)
      if (h !== undefined) return h
    }
    return undefined
  }
  if (typeof node !== 'object' || node === null || !('type' in node)) return undefined
  if (node.type === 'Button' && node.props.key === key) return node.press.handle
  return 'children' in node ? handleOf(node.children, key) : undefined
}

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'crew-deck', surface: 'desktop', component: 'Pane', requestId: 'crew-deck', props: PANE })

test('one press of the stop stops a running run', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  await spawnRun($)
  const ui = await mountPane($)

  expect((await ui.find({ key: 'stop-a1' }))?.type).toBe('Button')
  await ui.press({ key: 'stop-a1' })

  // Stopping: no Button left in the slot, and the row says so.
  expect((await ui.find({ key: 'stop-a1' }))?.type).not.toBe('Button')
  const rows = await ui.findAll({ type: 'Svg' })
  expect(rows.some(r => String(r.props.alt).includes('Map the code') && String(r.props.alt).includes('stopping'))).toBe(true)

  await ui.unmount()
})

// The page sends a click with the handle it drew; the host drops a handle
// once the next drawing is made. A Button that keeps its handle across
// redraws takes a click that lands after one.
test('the stop keeps its handle while the pane redraws', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  await spawnRun($)
  const ui = await mountPane($)

  const first = handleOf(await ui.drawn(), 'stop-a1')
  expect(first).toBeDefined()
  await ui.redraw()
  // A second run starting changes the drawing around the first one's stop.
  await $.agent.spawn({
    tool_use_id: 'toolu_2',
    prompt: 'Read the tests',
    description: 'Read the tests',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await ui.redraw()
  expect(handleOf(await ui.drawn(), 'stop-a1')).toBe(first)

  await ui.press({ key: 'stop-a1' })
  expect((await ui.find({ key: 'stop-a1' }))?.type).not.toBe('Button')

  await ui.unmount()
})

test('the fold arrow keeps its handle and folds after redraws', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  on('turn.complete', () => ({ text: 'Done' }))
  await spawnRun($)
  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'answer', answer: 'Done', durationMs: 1000, isAborted: false })
  const ui = await mountPane($)

  const first = handleOf(await ui.drawn(), 'fold-a1')
  expect((await ui.find({ key: 'fold-a1' }))?.props.label).toBe('▸')
  await ui.redraw()
  expect(handleOf(await ui.drawn(), 'fold-a1')).toBe(first)

  await ui.press({ key: 'fold-a1' })
  expect((await ui.find({ key: 'fold-a1' }))?.props.label).toBe('▾')

  await ui.unmount()
})
