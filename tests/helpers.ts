import type { ProcessSpawnRequest, SessionMessage, TurnStepChunk } from 'claude-code'
import { expect, mock, type TestBody } from 'claude-code/testing'

type TestDollar = Parameters<TestBody>[0]
type TestOn = Parameters<TestBody>[1]

export const STEP = { turnId: 't1', index: 0, model: 'haiku', messageCount: 1, agentId: 'a1' }
export const ROOT = new URL('..', (import.meta as ImportMeta & { url: string }).url).pathname.replace(/\/$/, '')
export const STUB = {
  name: 'stub',
  bin: 'stub',
  about: 'stub CLI agent.',
  readOnly: 'none',
  thinking: ['low', 'high'],
  steer: false,
  defaultModel: false,
} as const
export type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }
export type Write = { path: string; text: string }

// Adapter assertions inspect the request sent through the durable supervisor; the supervisor itself
// has process-transition tests with real local children in relay/test/durable.test.mjs.
export function requestOf(e: ProcessSpawnRequest): Spawn {
  const request: ProcessSpawnRequest =
    e.argv[1]?.endsWith('/relay/src/durable.mts') && e.argv[2] === 'start' ? JSON.parse(e.input ?? '{}') : e
  return { argv: [...request.argv], input: request.input, env: request.env }
}
const AGENT = { id: 'a1', description: 'x', type: 'via:pi', status: 'running' } as const
const EVENTS = [
  { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
  { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all ' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
  { type: 'message_end', message: { role: 'assistant', usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 } } },
]

export async function run($: TestDollar, step: typeof STEP = STEP) {
  const chunks: TurnStepChunk[] = []
  const stream = $.turn.step(step)
  for (;;) {
    const step = await stream.next()
    if (step.done) return { chunks, result: step.value }
    chunks.push(step.value)
  }
}

// Runs a turn to its end as the engine would: each step that ends with a call to via's tool gets the
// call answered through tool.call, then the next step. calls: what each answer said.
export async function runTurn($: TestDollar, step: typeof STEP = STEP) {
  const chunks: TurnStepChunk[] = []
  const calls: unknown[] = []
  for (let index = step.index; ; index += 1) {
    const done = await run($, { ...step, index })
    chunks.push(...done.chunks)
    const tool = done.chunks.find((c) => c.kind === 'tool')
    if (done.result.stopReason !== 'tool_use' || tool?.kind !== 'tool' || tool.name !== 'mcp__plugin_via_step__step')
      return { chunks, result: done.result, calls }
    const input = done.chunks.find((c) => c.kind === 'input')
    const args = input?.kind === 'input' ? (JSON.parse(input.json) as Record<string, unknown>) : {}
    calls.push(await $.tool.call({ tool: tool.name, tool_use_id: tool.id, ...args } as never))
  }
}

export function expectPiSpawn(spawn: Spawn | undefined, root: string, extra: string[] = []) {
  expect(spawn?.argv).toEqual(['pi', '-p', '--mode', 'json', '--session-id', 'pi-a1', '-e', `${root}/pi-extension/inbox.ts`, ...extra])
  expect(spawn?.env).toEqual({ PI_INBOX: '/home/u/.claude/via/inbox/pi-a1.jsonl' })
}

export const ENV = { TMPDIR: '/tmp', HOME: '/home/u' }

export function storage(on: TestOn, options: { get?: (key: string) => unknown; read?: boolean } = {}) {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  on('store.get', (_, e, next) => {
    const value = options.get ? options.get(e.key) : store.get(e.key)
    return value !== undefined || e.key === 'agents' ? { value } : next(e)
  })
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  if (options.read !== false) on('fs.read', (_, e, next) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : next(e)))
  return files
}

export function bottom(on: TestOn, writes?: Write[] | 'reject', env: Record<string, string> = ENV, version = NODE.stdout) {
  const files = storage(on)
  mock.env(on, env)
  on('agent.list', () => ({ value: [AGENT] }))
  on('fs.write', (_, e) => {
    if (writes === 'reject') throw new Error('EROFS')
    files.set(e.path, e.text)
    writes?.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  node(on, version)
}

// Every harness checks Node first, for the step server: a current one, and anything else run passes on.
export const NODE = { exitCode: 0, stdout: '26.12.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
export function node(on: TestOn, version = NODE.stdout) {
  on('process.run', (_, e, next) => (e.argv[0] === 'node' ? { value: { ...NODE, stdout: version } } : next(e)))
}

export function arrange(
  on: TestOn,
  spawns: Spawn[],
  pieces: { stream: 'stdout' | 'stderr'; text: string }[],
  code = 0,
  rows: SessionMessage[] = [],
  writes?: Write[] | 'reject',
  version = NODE.stdout,
) {
  bottom(on, writes, ENV, version)
  on('session.messages', () => ({ value: rows }))
  on('process.spawn', async function* (_, e) {
    spawns.push(requestOf(e))
    yield* pieces
    return { value: { code, signal: null } }
  })
}

export const split = (text: string) => [
  { stream: 'stdout' as const, text: text.slice(0, 40) },
  { stream: 'stdout' as const, text: text.slice(40) },
]
export const lines = `${EVENTS.map((e) => JSON.stringify(e)).join('\n')}\n`

const HALF = [
  { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'half an answer' } },
]

export function hang(on: TestOn, spawns: Spawn[], writes?: Write[], env: Record<string, string> = ENV, events: unknown[] = HALF) {
  bottom(on, writes, env)
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* (_, e, next) {
    spawns.push(requestOf(e))
    yield { stream: 'stdout' as const, text: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` }
    await new Promise<void>((resolve) => {
      if (next.signal.aborted) resolve()
      else next.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return { value: { code: 0, signal: null } }
  })
}

export function hold(on: TestOn, spawns: Spawn[], writes: Write[], before: unknown[], after: unknown[], env: Record<string, string> = ENV) {
  bottom(on, writes, env)
  on('session.messages', () => ({ value: [] }))
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  on('process.spawn', async function* (_, e) {
    spawns.push(requestOf(e))
    yield { stream: 'stdout' as const, text: `${before.map((event) => JSON.stringify(event)).join('\n')}\n` }
    await released
    yield { stream: 'stdout' as const, text: `${after.map((event) => JSON.stringify(event)).join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { release }
}
