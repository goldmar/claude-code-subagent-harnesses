import type { RenderElement, RenderInput, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__plugin_via_step__step'
const call = (index: number): RenderPropsOf['ToolGroup']['calls'][number] & { tool_use_id: string } => ({
  tool_use_id: `toolu_step_t1_${index}`,
  tool: TOOL,
  input: { kind: 'execute', title: `echo ${index}` },
  output: String(index),
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
})

const textOf = (node: unknown): string =>
  typeof node === 'string'
    ? node
    : typeof node === 'object' && node !== null && 'children' in node
      ? ((node as { children?: unknown[] }).children ?? []).map(textOf).join('')
      : ''

test('nested command rows keep their exact title and output after group expansion', async ($, on) => {
  const title = "sed -n '120,180p' src/example/long_module_name_for_wrapping.py; sed…"
  const output = 'first check PASS, selected count 7\nsecond check PASS\nthird check PASS'
  const calls = Array.from({ length: 10 }, (_, index) => call(index + 1))
  calls[8] = { ...calls[8], input: { kind: 'read', title: 'Read source' } }
  calls[9] = { ...calls[9], input: { kind: 'execute', title }, output }
  const seen: RenderInput[] = []
  on('ui.render', (_, e) => {
    seen.push(e)
    return { type: 'Text', children: ['native rows'] }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.ui.render({
      surface,
      component: 'ToolGroup',
      requestId: 'nested-group',
      props: { calls, isActive: true, isExpanded: false, isCallsOnly: true },
    })
    const group = seen.at(-1)
    if (group?.component !== 'ToolGroup') throw new Error('Expected native tool rows')
    expect(group.props).toEqual({ calls, isActive: true, isExpanded: true, isCallsOnly: true })
    // The installed flicker fix delegates separate rows instead of drawing a counted summary.
    // Keep the exact-output regression from the superseded grouped renderer on this live path.
    const row = (await $.ui.render({ surface, component: 'ToolUse', requestId: 'nested-command', props: calls[9] })) as RenderElement
    expect(row.type).toBe('Box')
    expect(row.props?.flexDirection).toBe('column')
    expect(row.children?.map(textOf)).toEqual([
      `Ran ${title}`,
      '  ⎿  first check PASS, selected count 7',
      '     second check PASS',
      '     third check PASS',
    ])
  }
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
