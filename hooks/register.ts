import type { EngineInterface, Register } from 'claude-code'
import { drawCall } from './acp/render'
import { answerCall, CHILD_CALL, endJob, waitStep } from './acp/steps'
import type { Adapter } from './adapter'
import { waitChild, woken } from './children'
import { respond, textChunks } from './handback'
import { HARNESSES } from './harnesses'
import { cachedModels, refreshModels } from './models'
import { descriptionOf, isModel, promptOf } from './prompt'
import { helperOf, ROSTER_UNAVAILABLE, roster, spawnOf } from './recovery'
import { notActivePrompt } from './run'
import { sendMessage, steer, typed } from './steer'
import { adapterOf, remember, turnStep } from './turn'
import type { World } from './world'

// Only harnesses installed at session start get an agent type: each description rides on every request.
async function onPath($: Pick<EngineInterface, 'env' | 'fs'>, bin: string): Promise<boolean> {
  const path = (await $.env.get('PATH')) ?? ''
  const dirs = path.split(path.includes(';') ? ';' : ':').filter(Boolean)
  const found = await Promise.all(
    dirs.flatMap((dir) =>
      [bin, `${bin}.exe`].map((name) =>
        $.fs.stat(`${dir}/${name}`).then(
          (s) => s.kind === 'file',
          () => false,
        ),
      ),
    ),
  )
  return found.includes(true)
}

// A teammate's messages arrive wrapped (<teammate-message teammate_id=… summary=…>task</teammate-message>):
// the harness gets the task alone, so its prompt lines (model:, tools:) are read from its top.
// Only a message that is nothing but envelopes is unwrapped. One linear pass: an attribute may hold a
// quoted >, and a message full of unclosed openers must not cost quadratic time.
// A SendMessage to a via agent that has answered resumes it with the message wrapped, so a slash
// command or a prompt line in it would not be at the top: codex-acp runs /compact only there.
const SENT = 'The coordinator sent a message while you were working:\n'
const ADDRESS = '\n\nAddress this before completing your current task.'
function fromCoordinator(text: string): string | undefined {
  if (!text.startsWith(SENT) || !text.endsWith(ADDRESS)) return undefined
  return text.slice(SENT.length, -ADDRESS.length).trim()
}
const OPEN = '<teammate-message'
const CLOSE = '</teammate-message>'
export function unwrapped(text: string): string {
  const sent = fromCoordinator(text)
  if (sent !== undefined) return sent
  const inner: string[] = []
  let at = 0
  for (;;) {
    while (at < text.length && /\s/.test(text[at] as string)) at += 1
    if (at === text.length) break
    if (!text.startsWith(OPEN, at) || !/[\s>]/.test(text[at + OPEN.length] ?? '')) return text
    // The opening tag ends at the first > outside quotes.
    let quote = ''
    let end = at + OPEN.length
    for (; end < text.length; end += 1) {
      const c = text[end] as string
      if (quote) quote = c === quote ? '' : quote
      else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    const close = text.indexOf(CLOSE, end + 1)
    if (end >= text.length || close < 0) return text
    inner.push(
      text
        .slice(end + 1, close)
        .replace(/^\r?\n/, '')
        .replace(/\r?\n$/, ''),
    )
    at = close + CLOSE.length
  }
  return inner.length > 0 ? inner.join('\n\n') : text
}

// The tool of the server plugin.json declares as `step`, named as Claude Code names a plugin's server.
const STEP = 'mcp__plugin_via_step__step'

const CLAUDE = /claude|opus|sonnet|haiku|fable/i
const KEPT = 4
const DROPPED = "Earlier steps of this run were dropped from Claude Code's copy; the harness still has them."

// Claude Code reads a via agent's usage as its own context and refuses a step past the window, 200k for
// a model it does not know. This variable sizes only such models; with a gateway model on the main loop
// it would size that too, so via sets it only while Claude is the main model, and never over the
// person's own value. via's value is told apart by being exactly RAISED, so a reload or a /model
// switch undoes only via's. The process's children inherit it, as any variable.
const RAISED = String(1e9)
async function sizeWindow($: Pick<EngineInterface, 'env'>, main: string): Promise<void> {
  const now = await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  if (now !== undefined && now !== RAISED) return
  if (CLAUDE.test(main)) {
    if (now === undefined) await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', RAISED)
  } else if (now === RAISED) await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', undefined)
}

// What the run will ask for, as turn.ts chooses it; the harness's own default is unknown until it answers.
function choiceOf(world: World, adapter: Adapter, prompt: string): { model?: string; thinking?: string } {
  const asked = promptOf(unwrapped(prompt), adapter)
  const fallback = adapter.defaultModel && isModel(world.defaultModel) ? world.defaultModel : undefined
  return { model: asked.model ?? fallback, thinking: asked.thinking }
}

export const register: Register = (on, options) => {
  const asked = options.timeoutMinutes
  const world: World = {
    adapters: new Map<string, Adapter>(HARNESSES.map((adapter) => [adapter.name, adapter])),
    defaultModel: typeof options.defaultModel === 'string' ? options.defaultModel.trim() : '',
    codexAcp: options.codexAcp === 'latest' ? 'latest' : 'pinned',
    timeoutMinutes: typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : 30,
    turns: new Map(),
    seeds: new Map(),
    handbacks: new Map(),
    installs: new Map(),
    modes: new Map(),
    agents: new Map(),
    others: new Set(),
    inboxes: new Map(),
    descriptions: new Map(),
    activity: new Map(),
    channels: new Map(),
    nested: new Map(),
    spawns: new Map(),
    tool: STEP,
    jobs: new Map(),
    calls: new Map(),
  }
  on('engine.create', async (_, e, next) => {
    const built = await next(e)
    return {
      ...built,
      viaChildren: { wait: ({ key }: { key: string }) => waitChild(world, key, (wake) => built.clock.after(5_000, wake)) },
      viaSteps: { wait: ({ agentId }: { agentId: string }) => waitStep(world, agentId, (wake) => built.clock.after(5_000, wake)) },
    }
  })
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Best effort: a hook that throws is skipped whole, and the agents below must still register.
    await $.session
      .model()
      .then((main) => sizeWindow($, main))
      .catch(() => undefined)
    // Each harness tool call reaches Claude Code as a call to this tool, served by mcp/step.mts, which
    // runs nothing: its tool.call hook answers with what the harness reported. Bash would look the same,
    // but a hook that fails is skipped and the real command would run; a call nobody answers fails.
    for (const adapter of world.adapters.values()) {
      if (!(await onPath($, adapter.bin))) continue
      const models = await cachedModels($, adapter, world.defaultModel)
      void refreshModels($, adapter).catch(() => undefined)
      await $.agent.register({
        name: adapter.name,
        description: descriptionOf(adapter, models),
        prompt: notActivePrompt(adapter.name),
        // Agent: a harness's own subagents show as agents nested under this one (hooks/acp/children.ts).
        tools: [world.tool, 'Agent'],
        model: adapter.name,
      })
    }
    return started
  })

  // A via agent's own Agent call, for its harness's subagent: approved here, since auto mode's classifier
  // judges only calls a model's request made, and via makes this one up.
  // Only the mode's own ask is settled here: a deny, or an ask from a rule, a setting, a hook or another
  // plugin, still stands.
  on('tool.check', { tool: 'Agent' }, async (_, e, next) => {
    const verdict = await next(e)
    const own = e.agentId !== undefined && world.agents.has(e.agentId) && e.tool_use_id?.startsWith(CHILD_CALL)
    const modes = verdict.decision === 'ask' && !verdict.rule && !verdict.hook && !verdict.setting && !verdict.plugin
    return own && modes ? { decision: 'allow', reason: "via's own call for its harness's subagent" } : verdict
  })

  // Typed into a via agent's view while it runs: Claude Code delivers it at the agent's next step, as an
  // attachment no model reads. A harness that takes steers reads it at its own next step instead.
  // Only what the person typed (here, or from their phone): a notification, a peer's or a channel's
  // message rides the same attachment and is not theirs to steer with.
  on('session.append', async ($, e, next) => {
    const inbox = e.agentId === undefined ? undefined : world.inboxes.get(e.agentId)
    const theirs = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (inbox !== undefined && theirs && e.message.type === 'attachment' && e.message.name === 'queued_command') {
      const message = typed(e.message.content)
      // A failed write loses the message: said, though the row is kept either way.
      if (message)
        await steer($, inbox, message).catch((err: unknown) => $.ui.log(`via could not pass your message to ${inbox.name}: ${String(err)}`))
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const [plugin, name = ''] = (e.subagentType ?? '').split(':')
    const adapter = plugin === $.plugin.name ? world.adapters.get(name) : undefined
    // A harness's subagent, which via shows from its parent's run: no harness of its own to choose.
    const key =
      adapter && e.tool_use_id.startsWith(CHILD_CALL)
        ? (world.spawns.get(e.tool_use_id) ?? (await spawnOf($, e.parentAgentId, e.tool_use_id)))
        : undefined
    if (adapter && key !== undefined) {
      world.spawns.delete(e.tool_use_id)
      // In the foreground the parent's step would wait on a nested agent that waits on the parent's run.
      if (!e.background) {
        const channel = world.channels.get(key)
        if (channel) channel.read = true
        return { deny: "via shows a harness's subagent only as a background agent, and background tasks are off" }
      }
      const model = world.channels.get(key)?.model
      const started = await next({ ...e, model: model ?? adapter.name, ...(model ? { description: `${e.description} · ${model}` } : {}) })
      if (started.agentId) {
        world.agents.set(started.agentId, adapter)
        world.nested.set(started.agentId, { key })
        world.handbacks.set(started.agentId, e.permissionMode === 'auto')
        const parent = key.slice(0, key.indexOf('/'))
        await remember(world, $, started.agentId, {
          harness: adapter.name,
          handback: e.permissionMode === 'auto',
          nested: { key, parent, run: (await roster($))[parent]?.run },
        })
      }
      return started
    }
    // No request reaches Claude: the agent's model is the harness's, which Claude Code stamps on every
    // response via makes up. Claude Code takes gateway model ids. The task shows what was asked for.
    // A resume keeps what its agent started with; a workflow agent's description is the script's.
    const choice = adapter && !e.resume ? choiceOf(world, adapter, e.prompt) : undefined
    const shown = choice && !e.workflow ? [choice.model, choice.thinking].filter(Boolean).join(' · ') : ''
    const started = await next(
      adapter && choice
        ? { ...e, model: choice.model ?? adapter.name, ...(shown ? { description: `${e.description} · ${shown}` } : {}) }
        : e,
    )
    if (started.agentId && adapter) {
      // agent.list may lag the first step, so learn the harness at the spawn.
      world.agents.set(started.agentId, adapter)
      world.seeds.set(started.agentId, e.prompt)
      world.descriptions.set(started.agentId, e.description)
      // What the person allows Claude itself; a harness maps it to its own modes. In memory before any
      // await, so a first step that runs before the state writes still sees it.
      world.modes.set(started.agentId, e.permissionMode ?? 'default')
      // The engine's handback reminder is not in session.messages, so remember the spawn's terms.
      // A remote spawn has no field here (isolation is on AgentSpec, not AgentSpawnInput), and
      // background cannot tell it from any other background spawn.
      const local = !e.isTeammate && e.workflow === undefined && !e.fork
      const handback = e.permissionMode === 'auto' && local
      // Persisted: a reload loses this map but must not lose the decision.
      world.handbacks.set(started.agentId, handback)
      await remember(world, $, started.agentId, { harness: adapter.name, handback })
      await $.state.set({ plugin: 'via', key: 'handbacks', id: started.agentId }, handback)
      await $.state.set({ plugin: 'via', key: 'modes', id: started.agentId }, e.permissionMode ?? 'default')
    }
    return started
  })

  on('turn.start', async (_, e, next) => {
    if (e.agentId !== undefined) {
      const rest = woken(e.text, world.nested)
      if (rest === '') {
        world.turns.set(e.turnId, { prompt: '', delivered: false, wake: true })
        return next(e)
      }
      const prompt = unwrapped(rest ?? e.text) || world.seeds.get(e.agentId)
      world.seeds.delete(e.agentId)
      if (prompt) world.turns.set(e.turnId, { prompt, delivered: false })
    }
    return next(e)
  })

  // No model reads a via agent's conversation, only the screen, and the harness keeps its own context.
  // Claude Code still refuses a step once the conversation passes its window, and its summarizer cannot
  // run on the harness's model: so via drops the old rows itself. Skipping would leave the step refused.
  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined || !(await adapterOf(world, $, e.agentId))) return next(e)
    if (e.trigger === 'precompute') return { skip: 'via compacts without a summary.' }
    // From an assistant message, so no tool result is kept without its call.
    const from = e.messages.findIndex((m, i) => i >= e.messages.length - KEPT && m.role === 'assistant')
    const note = { role: 'user' as const, text: DROPPED, toolUses: [] }
    return { messages: from === -1 ? [note] : [note, ...e.messages.slice(from)] }
  })

  // A /model switch to a gateway model must not keep a window sized for via's agents.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const done = await next(e)
    await sizeWindow($, e.to_model).catch(() => undefined)
    return done
  })

  on('turn.complete', async ($, e, next) => {
    world.turns.delete(e.turnId)
    for (const [agentId, job] of world.jobs) if (job.turnId === e.turnId) endJob(world, agentId)
    if (e.isAborted && e.agentId) {
      const receipt = (await roster($))[e.agentId]?.run
      if (receipt?.turnId === e.turnId) await $.process.run(['node', helperOf($), 'cancel', receipt.path], { timeoutMs: 7500 })
    }
    return next(e)
  })

  if (HARNESSES.some((adapter) => adapter.steer))
    on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => sendMessage(world, $, e, next))

  // The matcher's type names only built-in tools; an MCP tool's full name is accepted at run time.
  on('tool.call', { tool: STEP as 'Bash' }, ($, e, next) =>
    answerCall(
      world,
      e.tool_use_id,
      next.signal,
      (wake) => $.clock.after(30_000, wake),
      (agentId) => $.viaSteps.wait({ agentId }),
    ),
  ).catch(() => ({
    deny: 'via could not report this harness tool call.',
  }))

  on('ui.render', { component: 'ToolUse' }, (_, e, next) => (e.props.tool === world.tool ? drawCall(e.props) : next(e)))
  // Keep step rows in place: folding replaces them with a count as later calls arrive, which flickers.
  // Delegate expanded groups to the engine so each call still uses its ToolUse renderer.
  on('ui.render', { component: 'ToolGroup' }, (_, e, next) =>
    !e.props.isExpanded &&
    e.props.isCallsOnly === true &&
    e.props.calls.length > 0 &&
    e.props.calls.every((call) => call.tool === world.tool)
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e),
  )
  // The row shows the output already, all of it when expanded.
  on('ui.render', { component: 'ToolResult' }, (_, e, next) => (e.props.tool === world.tool ? { type: 'Box', children: [] } : next(e)))

  on('turn.step', async function* ($, e, next) {
    return yield* turnStep(world, $, e, next)
  }).catch(async function* (_, e, next) {
    const adapter = e.agentId === undefined ? undefined : world.agents.get(e.agentId)
    if (!adapter && next.error.message?.includes(ROSTER_UNAVAILABLE))
      return yield* respond(e, textChunks(ROSTER_UNAVAILABLE), ROSTER_UNAVAILABLE)
    if (!adapter) return yield* next(e)
    // A skipped hook would send this harness's model id to Anthropic. End the via turn instead.
    endJob(world, e.agentId as string)
    const report = `The ${adapter.name}${world.nested.has(e.agentId as string) ? ' subagent' : ''} failed: via could not render its next step.`
    const nested = world.nested.get(e.agentId as string)
    if (nested) nested.report = report
    return yield* respond(e, textChunks(report), report)
  })
}
