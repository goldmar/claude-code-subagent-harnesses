import type { AgentSpawnInput, SessionMessage } from 'claude-code'
import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { agy } from '../hooks/adapters/agy'
import { codex } from '../hooks/adapters/codex'
import { opencode } from '../hooks/adapters/opencode'
import { pi } from '../hooks/adapters/pi'
import { helpOf } from '../hooks/prompt'
import { storage } from './helpers'

type On = Parameters<TestBody>[1]

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_spawn',
  subagentType: 'via:pi',
  prompt: 'go',
  description: 'd',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'haiku',
  background: true,
  fork: false,
}

function spawned(on: On): string[] {
  storage(on)
  const models: string[] = []
  on('agent.spawn', (_, e) => {
    models.push(e.model ?? '')
    return { model: e.model ?? '', agentId: 'a1' }
  })
  return models
}

test("a via agent's model is the one its prompt asks the harness for", async ($, on) => {
  const models = spawned(on)
  await $.agent.spawn({ ...SPAWN, prompt: 'model: openrouter/kimi\n\ngo' })
  expect(models).toEqual(['openrouter/kimi'])
})

test("a via agent's model falls back to the defaultModel setting", { options: { defaultModel: 'openrouter/kimi' } }, async ($, on) => {
  const models = spawned(on)
  await $.agent.spawn(SPAWN)
  expect(models).toEqual(['openrouter/kimi'])
})

test("with no model asked a via agent's model names the harness, not a Claude model", async ($, on) => {
  const models = spawned(on)
  await $.agent.spawn({ ...SPAWN, subagentType: 'via:codex', prompt: 'go' })
  expect(models).toEqual(['codex'])
})

test("another plugin's spawn keeps its model", async ($, on) => {
  const models = spawned(on)
  await $.agent.spawn({ ...SPAWN, subagentType: 'other:pi', model: 'sonnet' })
  expect(models).toEqual(['sonnet'])
})

const row = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [], handle: text })
const ROWS = [
  row('user', 'u0'),
  row('assistant', 'a1'),
  row('user', 'u2'),
  row('assistant', 'a3'),
  row('user', 'u4'),
  row('assistant', 'a5'),
]

test("a via agent's compaction drops old rows without a summarizer, from an assistant row", async ($, on) => {
  spawned(on)
  let summarized = false
  on('session.compact', () => {
    summarized = true
    return { messages: [] }
  })
  await $.agent.spawn(SPAWN)
  const result = await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: ROWS })
  expect(summarized).toBe(false)
  expect(result.messages?.map((m) => m.handle ?? m.role)).toEqual(['user', 'a3', 'u4', 'a5'])
})

test("a via agent's precompute is skipped", async ($, on) => {
  spawned(on)
  await $.agent.spawn(SPAWN)
  const result = await $.session.compact({ trigger: 'precompute', agentId: 'a1', messages: ROWS })
  expect(result.skip).toBeDefined()
})

test("another agent's compaction runs as Claude Code's", async ($, on) => {
  storage(on)
  on('agent.list', () => ({ value: [] }))
  on('session.compact', () => ({ messages: [row('user', 'summary')] }))
  const result = await $.session.compact({ trigger: 'auto', agentId: 'b1', messages: ROWS })
  expect(result.messages?.map((m) => m.text)).toEqual(['summary'])
})

test('each harness lists its models in its own order, model ids only', () => {
  const debug = JSON.stringify({
    models: [
      { slug: 'gpt-6-luna', visibility: 'list', priority: 5 },
      { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
      { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1 },
    ],
  })
  expect(codex.catalogue.ids(debug)).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
  expect(codex.catalogue.ids('not json')).toEqual([])
  const table = 'provider    model           context  max-out\nopenrouter  cohere/north:free  128K  8K\n'
  expect(pi.catalogue.ids(table)).toEqual(['openrouter/cohere/north:free'])
  expect(agy.catalogue.ids('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n')).toEqual(['gemini-3.8-flash-high', ''])
  expect(opencode.catalogue.ids('opencode/beam-free\nopenrouter/x/y\n')).toEqual(['opencode/beam-free', 'openrouter/x/y', ''])
})

const SOL = JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', priority: 1 }] })

function codexOnPath(on: On, store: Map<string, unknown>, listing: { exitCode: number; stdout: string }) {
  const stored = new Promise<void>((resolve) => {
    on('store.set', (_, e) => {
      store.set(e.key, e.value)
      resolve()
      return { value: undefined }
    })
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  mock.env(on, { PATH: '/opt/bin', HOME: '/home/u' })
  on('fs.stat', (_, e) => {
    if (e.path !== '/opt/bin/codex') throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-haiku-5-5' }))
  const cwds: (string | undefined)[] = []
  on('process.run', (_, e, next) => {
    // The session's run pruning is not a model listing.
    if (e.argv[2] === 'prune') return next(e)
    cwds.push(e.init?.cwd)
    return { value: { ...listing, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const described: string[] = []
  on('agent.register', (_, e) => {
    described.push(e.description)
    return { value: { agent: `via:${e.name}` } }
  })
  return { described, stored, cwds }
}

test("a description names the harness's first model from its last listing, and the session refreshes it", async ($, on) => {
  const store = new Map<string, unknown>([['models.codex', ['gpt-6-luna']]])
  const { described, stored, cwds } = codexOnPath(on, store, { exitCode: 0, stdout: SOL })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await stored
  // From home: in the project, opencode would load the project's plugins.
  expect(cwds).toEqual(['/home/u'])
  expect(described[0]).toContain('`model: gpt-6-luna`')
  expect(store.get('models.codex')).toEqual(['gpt-6.1-sol'])
})

test('before any listing a description names no model, and a failed listing keeps the last one', async ($, on) => {
  const store = new Map<string, unknown>()
  const { described } = codexOnPath(on, store, { exitCode: 1, stdout: SOL })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(described[0]).not.toContain('model:')
  expect(store.has('models.codex')).toBe(false)
})

test('help lists what the harness offers', () => {
  const help = helpOf(codex, ['gpt-6.1-sol', 'gpt-6-luna'])
  expect(help).toContain('codex offers gpt-6.1-sol, gpt-6-luna.')
  expect(help).toContain('model: gpt-6.1-sol')
  expect(helpOf(codex, [])).not.toContain('offers')
})

test('the task shows the model and thinking the prompt asks for', async ($, on) => {
  const shown: string[] = []
  on('agent.spawn', (_, e) => {
    shown.push(e.description)
    return { model: e.model ?? '', agentId: 'a1' }
  })
  await $.agent.spawn({ ...SPAWN, prompt: 'model: openrouter/kimi\nthinking: high\n\ngo' })
  await $.agent.spawn({ ...SPAWN, prompt: 'go' })
  expect(shown).toEqual(['d · openrouter/kimi · high', 'd'])
})

function window(on: On, main: string, set?: string) {
  const writes: (string | undefined)[] = []
  mock.env(on, set === undefined ? {} : { CLAUDE_CODE_MAX_CONTEXT_TOKENS: set })
  on('env.set', (_, e) => {
    if (e.name === 'CLAUDE_CODE_MAX_CONTEXT_TOKENS') writes.push(e.value)
    return { value: {} }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: main }))
  return writes
}

test("with Claude on the main loop the session sizes harness models' window past any harness context", async ($, on) => {
  const writes = window(on, 'claude-haiku-5-5')
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(writes).toEqual(['1000000000'])
})

test('a gateway model on the main loop is left alone', async ($, on) => {
  const writes = window(on, 'gpt-6.1-sol')
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(writes).toEqual([])
})

test('a window the person set is left alone', async ($, on) => {
  const writes = window(on, 'claude-haiku-5-5', '300000')
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(writes).toEqual([])
})

test(
  "pi's configured default leads its list, and the plugin's defaultModel leads the description",
  { options: { defaultModel: 'openrouter/kimi' } },
  async ($, on) => {
    const store = new Map<string, unknown>()
    const stored = new Promise<void>((resolve) => {
      on('store.set', (_, e) => {
        store.set(e.key, e.value)
        resolve()
        return { value: undefined }
      })
    })
    on('store.get', (_, e) => ({ value: store.get(e.key) }))
    mock.env(on, { PATH: '/opt/bin', HOME: '/home/u' })
    on('fs.stat', (_, e) => {
      if (e.path !== '/opt/bin/pi') throw new Error('ENOENT')
      return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.model', () => ({ value: 'claude-haiku-5-5' }))
    const table = 'provider model\nopenrouter ~anthropic/claude-fable-latest\nopenrouter deepseek/v4\n'
    on('process.run', () => ({ value: { exitCode: 0, stdout: table, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('fs.read', (_, e) => {
      if (e.path !== '/home/u/.pi/agent/settings.json') throw new Error('ENOENT')
      return { value: JSON.stringify({ defaultProvider: 'openrouter', defaultModel: 'deepseek/v4' }) }
    })
    const described: string[] = []
    on('agent.register', (_, e) => {
      described.push(e.description)
      return { value: { agent: `via:${e.name}` } }
    })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    await stored
    expect(described[0]).toContain('`model: openrouter/kimi`')
    expect(store.get('models.pi')).toEqual(['openrouter/deepseek/v4', 'openrouter/~anthropic/claude-fable-latest'])
  },
)

function switched(on: On, set: string | undefined) {
  const writes: (string | undefined)[] = []
  let value = set
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CODE_MAX_CONTEXT_TOKENS' ? value : undefined }))
  on('env.set', (_, e) => {
    if (e.name === 'CLAUDE_CODE_MAX_CONTEXT_TOKENS') {
      writes.push(e.value)
      value = e.value
    }
    return { value: {} }
  })
  on('classic.PostModelSwitch', () => ({}))
  return writes
}
const SWITCH = {
  from_model: 'claude-haiku-5-5',
  requested_model: null,
  source: 'command',
  context_tokens: 0,
  prompt_cache_warm: false,
  cache_ttl: '5m',
  estimated_cache_write_usd: 0,
  pricing: 'default',
} as const

test("a switch to a gateway model undoes via's window, and a switch back raises it again", async ($, on) => {
  const writes = switched(on, '1000000000')
  await $.classic.PostModelSwitch({ ...SWITCH, to_model: 'gpt-6.1-sol' })
  await $.classic.PostModelSwitch({ ...SWITCH, to_model: 'claude-opus-5-5' })
  expect(writes).toEqual([undefined, '1000000000'])
})

test('a switch leaves a window the person set', async ($, on) => {
  const writes = switched(on, '300000')
  await $.classic.PostModelSwitch({ ...SWITCH, to_model: 'gpt-6.1-sol' })
  expect(writes).toEqual([])
})
