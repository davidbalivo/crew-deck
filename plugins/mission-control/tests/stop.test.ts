import { expect, mock, test } from 'claude-code/testing'
import type { RenderChildren, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  title: 'Mission Control',
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

type ButtonElement = Extract<RenderElement, { type: 'Button' }>
type BoxElement = Extract<RenderElement, { type: 'Box' }>

// The element under `key`, as the page gets it.
const elementOf = (node: RenderChildren, key: string): RenderElement | undefined => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const el = elementOf(child, key)
      if (el !== undefined) return el
    }
    return undefined
  }
  if (typeof node !== 'object' || node === null || !('type' in node)) return undefined
  if (node.props.key === key) return node
  return 'children' in node ? elementOf(node.children, key) : undefined
}

// The Button under `key`, as the page gets it.
const buttonOf = (node: RenderChildren, key: string): ButtonElement | undefined => {
  const el = elementOf(node, key)
  return el?.type === 'Button' ? el : undefined
}

// The Box under `key`, as the page gets it.
const boxOf = (node: RenderChildren, key: string): BoxElement | undefined => {
  const el = elementOf(node, key)
  return el?.type === 'Box' ? el : undefined
}

// The handle the host holds for the Button under `key`.
const handleOf = (node: RenderChildren, key: string): number | undefined => buttonOf(node, key)?.press.handle

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'mission-control', surface: 'desktop', component: 'Pane', requestId: 'mission-control', props: PANE })

test('one press of the stop stops a running run', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  await spawnRun($)
  const ui = await mountPane($)

  expect((await ui.find({ key: 'stop-a1' }))?.type).toBe('Button')
  await ui.press({ key: 'stop-a1' })

  // Stopping: the same Button stays in the slot, and the row says so.
  expect((await ui.find({ key: 'stop-a1' }))?.type).toBe('Button')
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
  // Stopping keeps the same Button, so the square does not move.
  expect(handleOf(await ui.drawn(), 'stop-a1')).toBe(first)

  await ui.unmount()
})

// The desktop builds the pane's page nodes anew on every drawing; a Button whose
// look changed under the pointer flashed once a second while runs worked.
test('the stop keeps its resting look under the pointer', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  await spawnRun($)
  const ui = await mountPane($)

  expect(buttonOf(await ui.drawn(), 'stop-a1')?.hover).toEqual({ dimColor: true, backgroundColor: 'rgba(0,0,0,0)' })

  await ui.unmount()
})

// The Box around the stop lights instead: a Box has no fade to flash.
test('the stop slot lights while running and not once stopping', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  await spawnRun($)
  const ui = await mountPane($)

  expect(boxOf(await ui.drawn(), 'slot-a1')?.hover).toEqual({ backgroundColor: 'rgba(128,128,128,0.2)' })
  await ui.press({ key: 'stop-a1' })
  expect(boxOf(await ui.drawn(), 'slot-a1')?.hover).toBeUndefined()

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
