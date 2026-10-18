import { expect, mock, test } from 'claude-code/testing'
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

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'crew-deck', surface: 'desktop', component: 'Pane', requestId: 'crew-deck', props: PANE })

test('a running run stops on the second press of its stop, not the first', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
  await spawnRun($)
  const ui = await mountPane($)

  const atRest = await ui.find({ key: 'stop-a1' })
  expect(atRest?.type).toBe('Button')
  expect(atRest?.props.dimColor).toBe(true)

  await ui.press({ key: 'stop-a1' })
  // Armed, not yet stopped: still a Button, now at full strength.
  const armed = await ui.find({ key: 'stop-a1' })
  expect(armed?.type).toBe('Button')
  expect(armed?.props.dimColor).toBeFalsy()

  await ui.press({ key: 'stop-a1' })
  // Stopping: no Button left in the slot, and the row says so.
  expect((await ui.find({ key: 'stop-a1' }))?.type).not.toBe('Button')
  const rows = await ui.findAll({ type: 'Svg' })
  expect(rows.some(r => String(r.props.alt).includes('Map the code') && String(r.props.alt).includes('stopping'))).toBe(true)

  await ui.unmount()
})
