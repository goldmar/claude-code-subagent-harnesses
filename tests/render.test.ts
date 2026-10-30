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

test('nested command rows keep their exact title and output inside a drawn group', async ($, on) => {
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
    })) as { children: { children: RenderElement[] }[] }
    expect(seen).toHaveLength(0)
    // The group draws each call's own row: keep the exact-output regression on that live path.
    const row = drawn.children[9]?.children[0] as RenderElement
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

test('step groups draw as rows as commands arrive, finish, and render again from history', async ($, on) => {
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
        const rows = (drawn as { children: { props: { key: string } }[] }).children
        // One row per call, keyed by its id, in order; never the engine's counted line.
        expect(rows.map((row) => row.props.key)).toEqual(current.map((c) => c.tool_use_id))
        expect(texts(drawn).join('|')).toBe(
          current.map((c, i) => (c.isRunning ? `Running| |echo ${i + 1}` : `Ran| |echo ${i + 1}|  ⎿  ${i + 1}`)).join('|'),
        )
        expect(props.isExpanded).toBe(false)
      }
    }
  }
  expect(seen).toHaveLength(0)
})

test('a row in a drawn group folds its output as a standalone row does', async ($) => {
  const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
  const props = { calls: [{ ...call(1), output }], isActive: false, isExpanded: false, isCallsOnly: true }
  const drawn = await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'long', props })
  expect(texts(drawn).join('|')).toBe('Ran| |echo 1|  ⎿  line 1|     line 2|     line 3|     … 47 more lines (ctrl+o to expand)')
})

test('a failed or interrupted call keeps its group as rows instead of the engine count', async ($, on) => {
  const seen: RenderInput[] = []
  on('ui.render', (_, e) => {
    seen.push(e)
    return { type: 'Text', children: ['native'] }
  })
  for (const failed of [{ isErrored: true }, { isInterrupted: true }]) {
    const props = { calls: [call(1), { ...call(2), ...failed }], isActive: false, isExpanded: false, isCallsOnly: false }
    const drawn = await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'failed', props })
    expect(texts(drawn)[0]).toBe('Ran')
    expect(texts(drawn).join('')).toContain(failed.isErrored ? 'Failed echo 2' : 'Interrupted echo 2')
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
  ]
  for (const props of groups) {
    await $.ui.render({ surface: 'terminal', component: 'ToolGroup', requestId: 'ordinary', props })
    const rendered = seen.at(-1)
    if (rendered?.component !== 'ToolGroup') throw new Error('Expected native tool rows')
    expect(rendered.props).toEqual(props)
  }
  expect(seen.length).toBe(groups.length)
})
