import type { RenderInput, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__plugin_via_step__step'
const call = (index: number): RenderPropsOf['ToolGroup']['calls'][number] => ({
  tool_use_id: `toolu_step_t1_${index}`,
  tool: TOOL,
  input: { kind: 'execute', title: `echo ${index}` },
  output: String(index),
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
})

test('step rows stay expanded as commands arrive, finish, and render again from history', async ($, on) => {
  const seen: RenderInput[] = []
  on('ui.render', (_, e) => {
    seen.push(e)
    return { type: 'Text', children: ['native rows'] }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const count of [1, 2, 3]) {
      const calls = Array.from({ length: count }, (_, index) => call(index + 1))
      for (const isActive of [true, false, false]) {
        const current = calls.map((call, index) => ({ ...call, isRunning: isActive && index === count - 1 }))
        const props = { calls: current, isActive, isExpanded: false, isCallsOnly: true }
        const before = seen.length
        await $.ui.render({ surface, component: 'ToolGroup', requestId: `group-${surface}`, props })
        expect(seen.length).toBe(before + 1)
        const rendered = seen.at(-1)
        if (rendered?.component !== 'ToolGroup') throw new Error('Expected native tool rows')
        expect(rendered.props).toEqual({ ...props, isExpanded: true })
        // Rendering must preserve the original rows and input object, including their stable ids.
        expect(props.isExpanded).toBe(false)
        expect(rendered.props.calls).toEqual(current)
      }
    }
  }
})

test('mixed groups, non-call groups, empty groups, and expanded groups keep native rendering', async ($, on) => {
  const seen: RenderInput[] = []
  on('ui.render', (_, e) => {
    seen.push(e)
    return { type: 'Text', children: ['native rows'] }
  })
  const base = { calls: [call(1)], isActive: false, isExpanded: false, isCallsOnly: true }
  const groups = [
    { ...base, calls: [call(1), { ...call(2), tool: 'Bash' }] },
    { ...base, calls: [{ ...call(1), tool: 'Bash' }] },
    { ...base, calls: [] },
    { ...base, isCallsOnly: false },
    { ...base, isExpanded: true },
  ]
  for (const props of groups) {
    await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'ordinary', props })
    const rendered = seen.at(-1)
    if (rendered?.component !== 'ToolGroup') throw new Error('Expected native tool rows')
    expect(rendered.props).toEqual(props)
  }
  expect(seen.length).toBe(groups.length)
})
