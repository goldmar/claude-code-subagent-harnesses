import { expect, mock, test } from 'claude-code/testing'
import { drawCall, NO_OUTPUT } from '../hooks/acp/render'
import { pi } from '../hooks/adapters/pi'
import { stepOf } from '../hooks/progress'
import { run as runHook } from '../hooks/run'
import type { World } from '../hooks/world'
import { ENV, hang, hold, run, type Spawn, type Write } from './helpers'

const START = { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } }
// No call id: a text line, as agy sends, which feeds the panel row. pi's calls carry ids and become steps
// instead (tests/adapters/pi.test.ts pins that pi emits no text line for them).
const TOOL = { type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test' } }
const END = { type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1 } } }
const TEXT = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } }
const ROW = '/home/u/.claude/via/rows/a1.jsonl'
const rows = (writes: Write[]) => writes.filter((write) => write.path === ROW).map((write) => write.text)

async function spawn($: Parameters<typeof run>[0], description: string) {
  await $.agent.spawn({
    tool_use_id: 'toolu_spawn',
    subagentType: 'via:pi',
    prompt: 'run the tests',
    description,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: false,
    fork: false,
  })
}

test('a running via agent writes its latest step to its agent-panel row', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run the tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  expect(writes.filter((write) => write.path === ROW).at(-1)?.text).toBe(
    `${JSON.stringify({ id: 'a1', content: 'via:pi · run the tests · ▸ bash: {"command":"npm test"} · 1 step' })}\n`,
  )
  release()
  await pending
})

test('a finished via agent clears its agent-panel row', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run the tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  release()
  await pending
  expect(writes.filter((write) => write.path === ROW).at(-1)?.text).toBe('')
})

test('a description and tool name with escape sequences reach the row without control characters', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const evil = { ...TOOL, toolName: 'bash\u001b[2J\u0007' }
  const { release } = hold(on, spawns, writes, [START, evil], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run\u001b[2J tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  const content = (JSON.parse(writes.filter((write) => write.path === ROW).at(-1)?.text ?? '""') as { content: string }).content
  expect(content).toBe('via:pi · run[2J tests · ▸ bash[2J: {"command":"npm test"} · 1 step')
  expect(content).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  release()
  await pending
})

test('a run starts by clearing its agent-panel row, before its first step', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run the tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  const rows = writes.filter((write) => write.path === ROW)
  expect(rows[0]?.text).toBe('')
  expect(rows[1]?.text).toContain('▸ bash')
  release()
  await pending
})

test('an aborted run clears its agent-panel row', async () => {
  const writes: Write[] = []
  const stop = new AbortController()
  let stepped!: () => void
  const step = new Promise<void>((resolve) => {
    stepped = resolve
  })
  const world: World = {
    adapters: new Map([['pi', pi]]),
    defaultModel: '',
    codexAcp: 'pinned',
    installs: new Map(),
    timeoutMinutes: 30,
    turns: new Map(),
    seeds: new Map(),
    handbacks: new Map(),
    modes: new Map(),
    agents: new Map(),
    others: new Set(),
    inboxes: new Map(),
    descriptions: new Map(),
    activity: new Map(),
    channels: new Map(),
    nested: new Map(),
    spawns: new Map(),
    tool: 'mcp__plugin_via_step__step',
    jobs: new Map(),
    calls: new Map(),
  }
  const $ = {
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    fs: {
      write: async (path: string, text: string) => {
        writes.push({ path, text })
        if (text.includes('▸ bash')) stepped()
      },
    },
    clock: { after: () => ({ cancel: () => {} }) },
    process: {
      spawn: async function* () {
        yield { stream: 'stdout' as const, text: `${[START, TOOL].map((event) => JSON.stringify(event)).join('\n')}\n` }
        await new Promise<void>((resolve) => {
          if (stop.signal.aborted) resolve()
          else stop.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { code: 0, signal: null }
      },
    },
    plugin: { root: '/' },
  } as unknown as Parameters<typeof runHook>[2]
  const input = {
    agentId: 'a1',
    choice: {},
    prompt: 'go',
    signal: stop.signal,
    inbox: undefined,
    session: undefined,
    guard: undefined,
    mode: 'default' as const,
  }
  const stream = runHook(world, pi, $, { ...input, probe: async () => undefined, save: async () => {} })
  const pending = (async () => {
    for (;;) if ((await stream.next()).done) return
  })()
  await step
  stop.abort()
  await pending
  expect(rows(writes)).toEqual(['', expect.stringContaining('▸ bash'), ''])
})

test('a run stopped at the time limit clears its agent-panel row', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes, ENV, [START, TOOL])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await clock.advance(30 * 60 * 1000)
  await pending
  expect(rows(writes).slice(-2)).toEqual([expect.stringContaining('▸ bash'), ''])
})

test('an empty description leaves out its agent-panel row segment', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, '')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  const row = writes.filter((write) => write.path === ROW).at(-1)?.text ?? ''
  expect((JSON.parse(row) as { content: string }).content).toBe('via:pi · ▸ bash: {"command":"npm test"} · 1 step')
  release()
  await pending
})

test('with no home folder no agent-panel row is written', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const { release } = hold(on, spawns, writes, [START, TOOL], [TEXT, END], { TMPDIR: '/tmp' })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawn($, 'run the tests')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const pending = run($)
  await clock.settle()
  release()
  await pending
  expect(writes.some((write) => write.path.includes('/.claude/via/rows/'))).toBe(false)
})

test('a step drops control characters, so a harness tool name cannot send escape sequences to the terminal', () => {
  expect(stepOf('\n▸ evil\u001b[2J\u001b]0;pwned\u0007: {"a":1}\n')).toBe('evil[2J]0;pwned: {"a":1}')
})

const call = (over: Partial<Parameters<typeof drawCall>[0]>): Parameters<typeof drawCall>[0] => ({
  tool_use_id: 't',
  tool: 'mcp__plugin_via_step__step',
  input: { kind: 'execute', title: 'npm test' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  ...over,
})
const texts = (node: unknown): string[] =>
  typeof node === 'string'
    ? [node]
    : typeof node === 'object' && node !== null && 'children' in node
      ? ((node as { children?: unknown[] }).children ?? []).flatMap(texts)
      : []

test("a harness command's row says it runs, then ran; any other call shows its own title", () => {
  expect(texts(drawCall(call({ isRunning: true }))).join('')).toBe('Running npm test')
  expect(texts(drawCall(call({ output: 'ok' }))).join('|')).toBe('Ran| |npm test|  ⎿  ok')
  expect(texts(drawCall(call({ input: { kind: 'read', title: "Read file 'src/a.ts'" } }))).join('')).toBe("Read file 'src/a.ts'")
  expect(texts(drawCall(call({ input: { kind: 'read', title: 'List files' }, isRunning: true }))).join('')).toBe('List files…')
  expect(texts(drawCall(call({ isErrored: true }))).join('')).toBe('Failed npm test')
  // A call that reported nothing shows no output line.
  expect(texts(drawCall(call({ output: NO_OUTPUT }))).join('|')).toBe('Ran| |npm test')
})

test("a harness call's row shows three lines of output unless expanded, and no control characters", () => {
  const output = 'a\nb\nc\nd\ne'
  expect(texts(drawCall(call({ output }))).join('|')).toBe('Ran| |npm test|  ⎿  a|     b|     c|     … 2 more lines (ctrl+o to expand)')
  expect(texts(drawCall(call({ output, isExpanded: true }))).length).toBe(8)
  expect(texts(drawCall(call({ input: { kind: 'execute', title: 'rm\u001b[2J -rf' } }))).join('')).toBe('Ran rm[2J -rf')
  // Nor bidirectional, zero-width or tag characters, which could make a row read as another command.
  expect(
    texts(drawCall(call({ input: { kind: 'execute', title: 'ls \u202egnp.exe\u200b\u{e0041}' }, output: 'ok\u2066' }))).join('|'),
  ).toBe('Ran| |ls gnp.exe|  ⎿  ok')
})

test("an edit's row colours the lines it took out and put in, and shows more of them before folding", () => {
  const row = drawCall(call({ input: { kind: 'edit', title: 'Edit notes.txt' }, output: 'notes.txt\n- a\n+ A' }))
  const found = (node: unknown, color: string): string[] =>
    typeof node === 'object' && node !== null
      ? [
          ...((node as { props?: { color?: string } }).props?.color === color ? texts(node) : []),
          ...((node as { children?: unknown[] }).children ?? []).flatMap((child) => found(child, color)),
        ]
      : []
  expect(found(row, 'diffRemoved')).toEqual(['- a'])
  expect(found(row, 'diffAdded')).toEqual(['+ A'])
  const long = Array.from({ length: 20 }, (_, i) => `+ line ${i}`).join('\n')
  expect(texts(drawCall(call({ input: { kind: 'edit', title: 'Edit a.ts' }, output: long }))).join('|')).toContain('… 8 more lines')
})

test("a plan's row is titled Plan and lists its entries", () => {
  expect(texts(drawCall(call({ input: { kind: 'plan', title: 'Plan' }, output: '☑ read\n◐ fix' }))).join('|')).toBe(
    'Plan|  ⎿  ☑ read|     ◐ fix',
  )
})

test('a call that names a file links its title to it', () => {
  const row = drawCall(call({ input: { kind: 'read', title: "Read file 'a.ts'", path: '/repo/a.ts' } })) as {
    children: { children: unknown[] }[]
  }
  const link = JSON.stringify(row.children[0])
  expect(link).toContain('"type":"Link"')
  expect(link).toContain('file:///repo/a.ts')
  const odd = JSON.stringify(drawCall(call({ input: { kind: 'read', title: 'x', path: '/my repo/#1.ts' } })))
  expect(odd).toContain('file:///my%20repo/%231.ts')
  expect(JSON.stringify(drawCall(call({ input: { kind: 'read', title: 'x', path: '/a/what?.ts' } })))).toContain('file:///a/what%3F.ts')
  expect(JSON.stringify(drawCall(call({ input: { kind: 'read', title: 'x', path: 'rel/a.ts' } })))).not.toContain('Link')
})

test('a call answered while its command still runs gives way to its continuation row', () => {
  const answered = { output: 'The harness tool is still running.' }
  expect(texts(drawCall(call(answered)))).toEqual([])
  expect(texts(drawCall(call({ ...answered, isExpanded: true }))).join('|')).toBe(
    'Running| |npm test|  ⎿  The harness tool is still running.',
  )
})

test('a run ended from outside while parked between pieces stops its harness', async () => {
  let killed = false
  const world = {
    adapters: new Map([['pi', pi]]),
    timeoutMinutes: 30,
    inboxes: new Map(),
    descriptions: new Map(),
    activity: new Map(),
    channels: new Map(),
    nested: new Map(),
    spawns: new Map(),
  } as unknown as World
  const $ = {
    env: { get: async () => undefined },
    fs: { write: async () => {} },
    clock: { after: () => ({ cancel: () => {} }) },
    process: {
      spawn: async function* () {
        try {
          yield { stream: 'stdout' as const, text: `${[START, TOOL].map((event) => JSON.stringify(event)).join('\n')}\n` }
          await new Promise(() => {})
        } finally {
          // The engine kills the child when its stream is returned.
          killed = true
        }
      },
    },
    plugin: { root: '/' },
  } as unknown as Parameters<typeof runHook>[2]
  const input = { agentId: 'a1', choice: {}, prompt: 'go', signal: new AbortController().signal, mode: 'default' as const }
  const stream = runHook(world, pi, $, { ...input, probe: async () => undefined, save: async () => {} } as never)
  // Parked at its first chunk, as after a step that read this far; then ended, as endJob or an Esc does.
  await stream.next()
  await stream.return(undefined as never)
  expect(killed).toBe(true)
})
