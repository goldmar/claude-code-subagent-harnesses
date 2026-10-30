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

const texts = (node: unknown): string[] =>
  typeof node === 'string'
    ? [node]
    : typeof node === 'object' && node !== null
      ? ((node as { children?: unknown[] }).children ?? []).flatMap(texts)
      : []

test('nested command titles stay on the summary and ctrl+o preserves their exact output', async ($, on) => {
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
    const drawn = (await $.ui.render({
      surface,
      component: 'ToolGroup',
      requestId: 'nested-group',
      props: { calls, isActive: true, isExpanded: false, isCallsOnly: true },
    })) as RenderElement
    expect(seen).toHaveLength(0)
    expect(textOf(drawn)).toBe(`Running 9 commands, reading 1 file… · ${title}`)
    expect(drawn.children).toHaveLength(1)
    const row = (await $.ui.render({
      surface,
      component: 'ToolUse',
      requestId: 'nested-expanded',
      props: { ...calls[9], isExpanded: true },
    })) as RenderElement
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

test('step groups stay collapsed from their first command through completion and history', async ($, on) => {
  const seen: RenderInput[] = []
  on('ui.render', (_, e) => {
    seen.push(e)
    return { type: 'Text', children: ['native'] }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const count of [1, 2, 3]) {
      const calls = Array.from({ length: count }, (_, index) => call(index + 1))
      for (const isActive of [true, false, false]) {
        const current = calls.map((call, index) => {
          const isRunning = isActive && index === count - 1
          return { ...call, isRunning, output: isRunning ? undefined : call.output }
        })
        const props = { calls: current, isActive, isExpanded: false, isCallsOnly: true }
        const drawn = await $.ui.render({ surface, component: 'ToolGroup', requestId: `group-${surface}`, props })
        const line = drawn as { props: { key: string }; children: { props: { wrap: string } }[] }
        expect(line.props.key).toBe('via-group')
        expect(line.children).toHaveLength(1)
        expect(line.children[0].props.wrap).toBe('truncate-end')
        const label = `${isActive ? 'Running' : 'Ran'} ${count} ${count === 1 ? 'command' : 'commands'}`
        expect(texts(drawn).join('')).toBe(`${label}${isActive ? `… · echo ${count}` : ''}`)
        expect(props.isExpanded).toBe(false)
      }
    }
  }
  expect(seen).toHaveLength(0)
})

test('a collapsed group hides output and ctrl+o delegates to native expanded rendering', async ($) => {
  const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
  const props = { calls: [{ ...call(1), output }], isActive: false, isExpanded: false, isCallsOnly: true }
  const drawn = await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'long', props })
  expect(texts(drawn).join('')).toBe('Ran 1 command')
  const expanded = await $.ui.render({
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'expanded',
    props: { ...call(1), output, isExpanded: true },
  })
  expect(texts(expanded).join('')).toContain('line 50')
  expect(texts(expanded).join('')).not.toContain('more lines')
})

test('already collapsed failed or interrupted groups keep the same summary line', async ($, on) => {
  const seen: RenderInput[] = []
  on('ui.render', (_, e) => {
    seen.push(e)
    return { type: 'Text', children: ['native'] }
  })
  for (const failed of [{ isErrored: true }, { isInterrupted: true }]) {
    const props = { calls: [call(1), { ...call(2), ...failed }], isActive: false, isExpanded: false, isCallsOnly: false }
    const drawn = await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'failed', props })
    expect(texts(drawn).join('')).toBe('Ran 2 commands, 1 failed')
    expect((drawn as { children: unknown[] }).children).toHaveLength(1)
  }
  expect(seen).toHaveLength(0)
})

test('mixed groups, groups with other rows, empty groups, and expanded groups keep native rendering', async ($, on) => {
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
    { ...base, isExpanded: true, isCallsOnly: false, calls: [{ ...call(1), isErrored: true }] },
    {
      ...base,
      isCallsOnly: false,
      calls: [
        { ...call(1), isInterrupted: true },
        { ...call(2), tool: 'Bash' },
      ],
    },
  ]
  for (const props of groups) {
    await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'ordinary', props })
    const rendered = seen.at(-1)
    if (rendered?.component !== 'ToolGroup') throw new Error('Expected native tool rows')
    expect(rendered.props).toEqual(props)
  }
  expect(seen.length).toBe(groups.length)
})

test('running continuations keep one command count and the latest title on the collapsed line', async ($) => {
  const command = { ...call(1), output: 'The harness tool is still running' }
  const wait = { ...call(2), input: { kind: 'wait', title: 'npm test\nstill running' }, isRunning: true }
  for (const calls of [
    [command, wait],
    [command, { ...wait, isRunning: false }, wait],
  ]) {
    const drawn = await $.ui.render({
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'wait',
      props: { calls, isActive: true, isExpanded: false, isCallsOnly: true },
    })
    expect(texts(drawn).join('')).toBe('Running 1 command… · npm test still running')
    expect((drawn as { children: unknown[] }).children).toHaveLength(1)
  }
})

test('mixed step kinds and multiple failures share one summary without output rows', async ($) => {
  const calls = [
    call(1),
    { ...call(2), input: { kind: 'read', title: 'Read source' }, isErrored: true },
    { ...call(3), isInterrupted: true },
  ]
  const drawn = await $.ui.render({
    surface: 'desktop',
    component: 'ToolGroup',
    requestId: 'mixed-kinds',
    props: { calls, isActive: false, isExpanded: false, isCallsOnly: false },
  })
  expect(texts(drawn).join('')).toBe('Ran 2 commands, read 1 file, 2 failed')
  expect((drawn as { children: unknown[] }).children).toHaveLength(1)
})
