import { expect, test } from 'claude-code/testing'

import { agy } from '../hooks/adapters/agy'
import { codex } from '../hooks/adapters/codex'
import { opencode } from '../hooks/adapters/opencode'
import { pi } from '../hooks/adapters/pi'
import { descriptionOf, helpOf, nearestModels, promptOf } from '../hooks/prompt'
import { unwrapped } from '../hooks/register'

const HELP = helpOf(pi, [])

import { arrange, expectPiSpawn, lines, ROOT, run, type Spawn, STEP, STUB, split } from './helpers'

test('pi-model and pi-tools lines are both passed and stripped from the prompt', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: read\npi-model: openrouter/kimi\nlist files' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na'])
  expect(spawns[0]?.input).toBe('list files')
})

test('a pi-tools list stays one argv element after --tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: -bash,read\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--tools', '-bash,read'])
  expect(spawns[0]?.input).toBe('go')
})

test('a prompt with no pi-tools line passes no --tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('go')
})

test('a follow-up turn without a pi-tools line keeps the agent tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: read\ngo' })
  await run($)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and now the tests' })
  await run($, { ...STEP, turnId: 't2', messageCount: 2 })
  expectPiSpawn(spawns[1], ROOT, ['--tools', 'read', '-na'])
  expect(spawns[1]?.input).toBe('and now the tests')
})

test('a pi-thinking line is passed and stripped from the prompt', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-thinking: high\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--thinking', 'high'])
  expect(spawns[0]?.input).toBe('go')
})

test('an invalid pi-thinking level answers with the bad value and the valid levels without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-thinking: extreme\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toContain('got "extreme"')
  expect(result.answer).toContain('off, minimal, low, medium, high, xhigh, max')
})

test('a follow-up turn without a pi-thinking line keeps the agent thinking level', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-thinking: high\ngo' })
  await run($)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and now the tests' })
  await run($, { ...STEP, turnId: 't2', messageCount: 2 })
  expectPiSpawn(spawns[1], ROOT, ['--thinking', 'high'])
  expect(spawns[1]?.input).toBe('and now the tests')
})

test('a pi-tools line in the body after the task is left in the prompt and passes no --tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'review this log\npi-tools: *' })
  await run($)
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('review this log\npi-tools: *')
})

test('an unknown pi line in the header answers without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tool: read\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toContain('pi-tool: read')
  expect(result.answer).toContain('pi-model')
  expect(result.answer).toContain('pi-tools')
  expect(result.answer).toContain('pi-thinking')
})

test('a pi-thinking value outside the levels answers without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-thinking: x-high\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toContain('pi-thinking: x-high')
})

test('a pi-tools value of more than one word answers without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tools: read bash\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toContain('"pi-tools: read bash"')
})

test('a pi-help line alone answers with HELP without spawning pi or storing anything', async ($, on) => {
  const spawns: Spawn[] = []
  const writes: unknown[] = []
  arrange(on, spawns, split(lines))
  on('state.set', (_, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-help' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(writes).toEqual([])
  expect(result.answer).toBe(HELP)
})

test('a pi-help line with a task still answers HELP, case-insensitively, without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'PI-Help\nlist files' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toBe(HELP)
})

test('an invalid pi header line answers with its reason and then HELP', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-tool: read\ngo' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer.startsWith('Invalid pi prompt line "pi-tool: read": unknown key')).toBe(true)
  expect(result.answer).toContain(HELP)
})

test('a header of model, tools and thinking lines is all passed and stripped', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({
    turnId: 't1',
    agentId: 'a1',
    text: 'pi-model: openrouter/kimi\npi-tools: read\npi-thinking: high\nlist files',
  })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('list files')
})

test('a header-only prompt sends an empty message', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-model: openrouter/kimi' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
  expect(spawns[0]?.input).toBe('')
})

test('neutral model, tools and thinking lines are passed and stripped', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: openrouter/kimi\ntools: read\nthinking: high\nlist files' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('list files')
})

test('pi- prompt lines remain aliases beside the neutral ones', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: openrouter/kimi\npi-tools: read\npi-thinking: high\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('go')
})

test('a via-help line answers with HELP without spawning pi', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'via-help' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toBe(HELP)
})

test('prose that merely starts with a key word is not a header', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'models are hard\nthinking about it\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('models are hard\nthinking about it\ngo')
})

test('a tools line is refused on an adapter that cannot enforce read-only', () => {
  const refused = promptOf('tools: read\ngo', STUB)
  expect(refused.error).toContain('stub cannot enforce read-only tools')
  expect(refused.prompt).toBe('tools: read\ngo')
  expect(promptOf('thinking: low\ngo', STUB).thinking).toBe('low')
  expect(promptOf('thinking: extreme\ngo', STUB).error).toContain('low, high')
})

test('help is generated from the adapter fields', () => {
  const stubHelp = helpOf(STUB, [])
  expect(stubHelp).toContain('refused: stub cannot enforce read-only tools')
  expect(stubHelp).toContain('low, high')
  expect(stubHelp).toContain('no mid-run steering')
  expect(stubHelp).toContain('— answered by stub')
  expect(HELP).toContain('off, minimal, low, medium, high, xhigh, max')
  expect(HELP).toContain('passed to pi as its tool list')
  expect(HELP).toContain('read is read-only; any other list, such as -bash,read, can still edit')
  expect(HELP).toContain('at its next step')
  expect(HELP).toContain('interrupt:')
})

test('help and description say every ACP harness steers mid-run and takes interrupt:', () => {
  for (const adapter of [codex, opencode]) {
    const help = helpOf(adapter, [])
    expect(help).toContain('at its next step')
    expect(help).toContain('interrupt:')
    expect(help).toContain('runs read-only and cannot edit files')
    expect(help).not.toContain('sandbox')
    expect(descriptionOf(adapter, [])).toContain('steers it mid-run')
  }
})

test('only a harness that steers tells Claude about interrupt:', () => {
  expect(descriptionOf(pi, [])).toContain('`interrupt:`')
  expect(descriptionOf(codex, [])).toContain('`interrupt:`')
  expect(descriptionOf(agy, [])).not.toContain('interrupt')
})

test('a model line starting with - is refused, so it can never be read as a flag', () => {
  expect(promptOf('model: --dangerously-skip-permissions\ngo', pi).error).toBeDefined()
  expect(promptOf('model: openrouter/x-y\ngo', pi).error).toBeUndefined()
  expect(promptOf('tools: -bash,read\ngo', pi).error).toBeUndefined()
})

test("a teammate's wrapped message reaches the harness unwrapped, its prompt lines read from the top", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  const text = '<teammate-message teammate_id="team-lead" summary="x">\nmodel: openrouter/kimi\nlist files\n</teammate-message>'
  await $.turn.start({ turnId: 't1', agentId: 'a1', text })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
  expect(spawns[0]?.input).toBe('list files')
})

test('two wrapped teammate messages become one prompt; text around an envelope is left as written', () => {
  const two =
    '<teammate-message teammate_id="a">\nfirst\n</teammate-message>\n<teammate-message teammate_id="b">\nsecond\n</teammate-message>'
  expect(unwrapped(two)).toBe('first\n\nsecond')
  const mixed = 'see <teammate-message teammate_id="a">x</teammate-message> here'
  expect(unwrapped(mixed)).toBe(mixed)
})

test("an envelope's quoted > and CRLF lines stay out of the task, and unclosed openers cost linear time", () => {
  expect(unwrapped('<teammate-message summary="a > b">\nmodel: x\ngo\n</teammate-message>')).toBe('model: x\ngo')
  expect(unwrapped('<teammate-message teammate_id="a">\r\nmodel: x\r\ngo\r\n</teammate-message>')).toBe('model: x\r\ngo')
  const unclosed = '<teammate-message a="1">x'.repeat(50_000)
  const started = performance.now()
  expect(unwrapped(unclosed)).toBe(unclosed)
  expect(performance.now() - started).toBeLessThan(1000)
  // Nested or stray envelopes are not unwrapped at all.
  const nested = '<teammate-message a="1"><teammate-message b="2">x</teammate-message></teammate-message>'
  expect(unwrapped(nested)).toBe(nested)
})

// As Claude Code 2.1.310 resumes an agent that answered, captured from a live SendMessage.
const resumed = (message: string) =>
  `The coordinator sent a message while you were working:\n${message}\n\nAddress this before completing your current task.`

test('a follow-up SendMessage reaches the harness unwrapped, so its prompt lines and slash commands lead', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: resumed('model: openrouter/kimi\n/compact') })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
  expect(spawns[0]?.input).toBe('/compact')
})

test('only the whole coordinator wrapper is taken off; a message quoting it is left as written', () => {
  expect(unwrapped(resumed('Reply with TWO.'))).toBe('Reply with TWO.')
  const quoted = `Look: ${resumed('x')}`
  expect(unwrapped(quoted)).toBe(quoted)
  const unended = 'The coordinator sent a message while you were working:\nx'
  expect(unwrapped(unended)).toBe(unended)
})

test('a refused model is matched to the offered ones that share its name parts, closest first', () => {
  const offered = [
    'opencode/beam-free',
    'opencode/deepseek-v4.1-flash-free',
    'openrouter/deepseek/deepseek-v4-flash',
    'opencode/glm-5.3-flash-free',
    'openrouter/~anthropic/claude-fable-latest',
  ]
  expect(nearestModels('opencode/deepseek-v4-free', offered)).toEqual([
    'opencode/deepseek-v4.1-flash-free',
    'opencode/beam-free',
    'openrouter/deepseek/deepseek-v4-flash',
  ])
  // The provider alone matches nothing: every opencode model shares it.
  expect(nearestModels('opencode/zzz', offered)).toEqual([])
  expect(nearestModels('gpt-6-luna', [])).toEqual([])
  // Captured 2026-10-28 from codex's list: a tie on name parts goes to the longest common start.
  expect(nearestModels('gpt-6-lunar', ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])[0]).toBe('gpt-6-luna')
})

test('tools: write is the same as no tools line where read is the only restriction', () => {
  expect(promptOf('tools: write\ngo', opencode)).toEqual({ prompt: 'go', tools: 'write' })
  expect(promptOf('tools: write\ngo', codex).error).toBeUndefined()
  expect(promptOf('tools: edit\ngo', opencode).error).toContain('read, write')
})

test('codex tier lines are parsed beside the other choices, with the first tier winning', () => {
  expect(promptOf('model: gpt-6.1-sol\ntools: read\nthinking: high\ntier: fast\nreview', codex)).toEqual({
    prompt: 'review',
    model: 'gpt-6.1-sol',
    tools: 'read',
    thinking: 'high',
    tier: 'fast',
  })
  expect(promptOf('codex-tier: default\ntier: fast\ngo', codex)).toEqual({ prompt: 'go', tier: 'default' })
  expect(promptOf('review this\ntier: fast', codex)).toEqual({ prompt: 'review this\ntier: fast' })
})

test('tier refuses invalid values and every non-codex harness', () => {
  for (const value of ['', 'priority', 'FAST', 'fast default']) {
    const text = `tier: ${value}\ngo`
    const asked = promptOf(text, codex)
    expect(asked.error).toBeDefined()
    expect(asked.prompt).toBe(text)
    expect(asked.tier).toBeUndefined()
  }
  for (const adapter of [agy, opencode, pi, STUB]) {
    expect(promptOf('tier: fast\ngo', adapter).error).toContain('tier is codex only')
    expect(promptOf(`${adapter.name}-tier: default\ngo`, adapter).error).toContain('tier is codex only')
    expect(helpOf(adapter, [])).not.toContain('tier: fast|default')
  }
  expect(helpOf(codex, [])).toContain('tier: fast|default')
  expect(helpOf(codex, [])).toContain('idle follow-up')
})
