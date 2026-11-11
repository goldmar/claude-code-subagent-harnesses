import type { EngineInterface, StreamHook, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Choice } from '../types'
import { endJob, type Job, type Mark, pump } from './acp/steps'
import type { Adapter, Mode } from './adapter'
import { childRun } from './children'
import { deliver, HANDBACK_TOOL, handbackAsked, respond, textChunks } from './handback'
import { relayReady } from './install'
import { cachedModels } from './models'
import { helpOf, isModel, promptOf } from './prompt'
import { type AgentRecord, recordOf, updateRecord } from './record'
import { cutOff, type RunResult, run } from './run'
import { openInbox } from './steer'
import type { Turn, World } from './world'

type StepHook = StreamHook<'turn.step'>
type Engine = Parameters<StepHook>[0]
type Step = Parameters<StepHook>[1]

// Which harness runs an agent, from its record; else from agent.list, for an agent spawned before via loaded.
// The record comes first: the new process of a session sent to the background resumes the agent as
// general-purpose, and its step would go to Claude under the harness's model name.
export async function adapterOf(w: World, $: Engine, agentId: string): Promise<Adapter | undefined> {
  if (w.others.has(agentId)) return undefined
  const record = await recordOf(w, $, agentId)
  const known = record ? w.adapters.get(record.harness) : undefined
  if (known) return known
  const agent = (await $.agent.list()).find((a) => a.id === agentId)
  // Not listed yet: decide on a later step rather than caching a guess.
  if (agent === undefined) return undefined
  const [plugin, name = ''] = agent.type.split(':')
  const adapter = plugin === $.plugin.name ? w.adapters.get(name) : undefined
  // The spawn's mode is unknown here, so the strictest: a read-only run, never one with more permission than
  // the person gave. In memory only, so a store that failed to answer cannot lose the real record.
  if (adapter) w.records.set(agentId, { harness: adapter.name, handback: false, mode: 'plan', rebuilt: true })
  else w.others.add(agentId)
  return adapter
}

// The spawn's terms, or the engine's handback reminder in the agent's conversation.
async function handbackOf($: Engine, agentId: string, record: AgentRecord): Promise<boolean> {
  return record.handback || (await handbackAsked($, agentId))
}

// Walks up from the session's folder: relative paths resolve there, and the root is its own parent.
// Says `unchecked` when it cannot finish (a stat refused, or a hook withheld realPath): not proven clean.
async function foundAbove(
  $: Engine,
  folder: string,
  harmless: readonly string[],
  skip?: string,
): Promise<string | 'unchecked' | undefined> {
  let prefix = ''
  for (let depth = 0; depth < 64; depth += 1) {
    const found = await $.fs.stat(`${prefix}${folder}`, { resolve: true }).catch(() => undefined)
    const hit = found !== undefined && skip !== undefined && found.realPath === skip ? undefined : found
    if (hit !== undefined && hit.kind !== 'dir') return hit.realPath ?? `${prefix}${folder}`
    if (hit?.kind === 'dir') {
      // A folder that cannot be listed is not proven harmless.
      const entries = await $.fs.list(`${prefix}${folder}`).catch(() => undefined)
      if (entries === undefined || entries.some((entry) => !harmless.includes(entry.name))) return hit.realPath ?? `${prefix}${folder}`
    }
    const here = await $.fs.stat(prefix || '.', { resolve: true }).catch(() => undefined)
    const up = await $.fs.stat(`${prefix}..`, { resolve: true }).catch(() => undefined)
    if (!here?.realPath || !up?.realPath) return 'unchecked'
    if (here.realPath === up.realPath) return undefined
    prefix += '../'
  }
  return 'unchecked'
}

async function probeModel($: Engine, adapter: Adapter, choice: Choice, session?: string): Promise<string | undefined> {
  if (!adapter.probe) return undefined
  const env = adapter.probe.env?.(choice)
  const asked = await $.process
    .run(adapter.probe.argv(choice, session), { timeoutMs: 15_000, ...(env ? { env } : {}) })
    .catch(() => undefined)
  return asked?.exitCode === 0 ? adapter.probe.model(asked.stdout) : undefined
}

// A guard that cannot prove a read-only run safe refuses it; the string says why.
async function readOnlyGuard($: Engine, adapter: Adapter): Promise<Readonly<Record<string, string>> | string | undefined> {
  const guard = adapter.readOnlyGuard
  if (!guard) return undefined
  const listed = await $.process.run(guard.argv, { timeoutMs: 15_000 }).catch(() => undefined)
  return (listed?.exitCode === 0 ? guard.env(listed.stdout) : undefined) ?? guard.why
}

// A step that runs nothing: the agent's last answer again, or that its run was cut off (a session sent to
// the background, or a reload mid-run). Handed back once, when the agent hands back; Claude Code takes the
// last text as the answer even after a handback, so an answer already handed back is repeated as text.
// force: the turn's run answered without a handback and Claude Code stepped again, asking for one.
async function* replay(
  w: World,
  $: Engine,
  e: Step,
  agentId: string,
  adapter: Adapter,
  record: AgentRecord,
  force = false,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const said = record.report || cutOff(adapter.name)
  // A transcript that cannot be read leaves the spawn's terms: a replay never fails over it.
  if (!record.handedBack && (force || (await handbackOf($, agentId, record).catch(() => record.handback)))) {
    await updateRecord(w, $, agentId, { handedBack: true })
    return yield* deliver(adapter.name, e, 0, said, null)
  }
  return yield* respond(e, textChunks(said), said)
}

// A nested agent's steps: its harness subagent's rows and answer, read from its parent's run.
async function* nestedStep(
  w: World,
  $: Engine,
  e: Step,
  agentId: string,
  adapter: Adapter,
  record: AgentRecord,
  signal: AbortSignal,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  let job = w.jobs.get(agentId)
  if (job === undefined) {
    // After its answer, or a later message: the answer again.
    if (record.report !== undefined) return yield* replay(w, $, e, agentId, adapter, record)
    const abort = new AbortController()
    const handback = await handbackOf($, agentId, record)
    job = {
      turnId: e.turnId,
      gen: childRun(w, agentId, adapter.name, e, abort.signal, handback, (key) => $.viaChildren.wait({ key })),
      held: [],
      outputs: new Map(),
      abort,
      count: 0,
    }
    w.jobs.set(agentId, job)
  }
  const result = yield* pump(w, job, e, signal, joining($, agentId, job.turnId))
  // Its answer, once it has one, for a later step and a new process. childRun has handed it back by then.
  // Handed back only if that step did: a run that could not be followed ends as text.
  if (job.final?.answer) {
    const handedBack = job.final.toolUses.some((use) => use.name === HANDBACK_TOOL)
    await updateRecord(w, $, agentId, { report: job.final.answer, handedBack })
  }
  return result
}

// A step's wait for its run's next chunk: the engine's bounded wait, see waitStep.
function joining($: Engine, agentId: string, turnId: string): () => Promise<void> {
  return () => $.viaSteps.wait({ agentId, turnId })
}

// A run outlives the step that started it: each harness tool call ends a step with a call to via's
// tool, whose tool.call hook reads the run on until the harness finishes that call (answerCall), and
// the next step reads on from there. Whichever hook reads the run lends it its abort signal.
export async function* turnStep(w: World, $: Engine, e: Step, next: Parameters<StepHook>[2]) {
  const agentId = e.agentId
  if (agentId === undefined) return yield* next(e)
  const adapter = await adapterOf(w, $, agentId)
  const record = w.records.get(agentId)
  if (adapter === undefined || record === undefined) return yield* next(e)
  if (record.nested) {
    // One another process spawned has no parent run here: its saved answer or the cut-off, never a new run
    // of the harness on the nested agent's prompt.
    if (!w.nested.has(agentId)) return yield* replay(w, $, e, agentId, adapter, record)
    return yield* nestedStep(w, $, e, agentId, adapter, record, next.signal)
  }
  const turn = w.turns.get(e.turnId)
  if (turn?.wake) return yield* respond(e, textChunks(record.report ?? ''), record.report ?? '')
  const job = w.jobs.get(agentId)
  if (job !== undefined) {
    if (job.turnId === e.turnId) return yield* pump(w, job, e, next.signal, joining($, agentId, e.turnId))
    endJob(w, agentId)
  }
  if (turn === undefined) return yield* replay(w, $, e, agentId, adapter, record)
  if (turn.done) return yield* replay(w, $, e, agentId, adapter, record, true)
  const started = yield* begin(w, adapter, $, e, agentId, record, turn)
  if ('answer' in started) return started
  w.jobs.set(agentId, started)
  return yield* pump(w, started, e, next.signal, joining($, agentId, e.turnId))
}

// Everything before the run: refusals answer at once; otherwise the run as a job.
async function* begin(
  w: World,
  adapter: Adapter,
  $: Engine,
  e: Step,
  agentId: string,
  record: AgentRecord,
  turn: Turn,
): AsyncGenerator<TurnStepChunk, TurnStepResult | Job> {
  const defaultModel = adapter.defaultModel ? w.defaultModel : ''
  if (defaultModel && !isModel(defaultModel)) {
    const bad = `The via plugin's defaultModel setting ${JSON.stringify(defaultModel)} is not a ${adapter.name} --model pattern.`
    return yield* respond(e, textChunks(bad), bad)
  }
  const asked = promptOf(turn.prompt, adapter)
  if (asked.help) {
    const help = helpOf(adapter, await cachedModels($, adapter, w.defaultModel))
    return yield* respond(e, textChunks(help), help)
  }
  if (asked.error !== undefined) {
    const bad = `${asked.error}\n\n${helpOf(adapter, await cachedModels($, adapter, w.defaultModel))}`
    return yield* respond(e, textChunks(bad), bad)
  }

  const held = record.choice
  const merged: Choice = {
    ...held,
    ...(asked.model ? { model: asked.model } : {}),
    ...(asked.tools ? { tools: asked.tools } : {}),
    ...(asked.thinking ? { thinking: asked.thinking } : {}),
  }
  const changed = merged.model !== held?.model || merged.tools !== held?.tools || merged.thinking !== held?.thinking
  if (changed) await updateRecord(w, $, agentId, { choice: merged })

  // What the person allows Claude itself, as the spawn carried it: plan mode is read-only here too.
  const mode = record.mode as Mode
  const withModel: Choice = merged.model ? merged : { ...merged, ...(defaultModel ? { model: defaultModel } : {}) }
  // An agent with no record runs read-only (adapterOf): its refusals say so, not that the person chose it.
  const anyway = record.rebuilt
    ? `via has no record of the permission mode this agent was spawned with, so it runs read-only. Start a new agent to run it with your current mode.`
    : 'To run it anyway, start a new agent without `tools: read`, outside plan mode; or ask a harness that can enforce read-only.'
  if (mode === 'plan' && adapter.readOnly === 'none') {
    const refused = record.rebuilt
      ? `${adapter.name} cannot run read-only: it has no read-only mode that via can enforce. ${anyway}`
      : `${adapter.name} cannot run in plan mode: it has no read-only mode that via can enforce. Leave plan mode to run it, or ask a harness that can enforce read-only.`
    return yield* respond(e, textChunks(refused), refused)
  }
  // Plan mode is read-only whatever tools line the prompt carries: a pi list such as `bash` would run commands.
  const chosen: Choice = mode === 'plan' ? { ...withModel, tools: adapter.tools?.[0] ?? 'read,grep,find,ls' } : withModel
  const unsafe = chosen.tools === 'read' ? adapter.unsafeReadOnly : undefined
  const ownHome = unsafe?.own ? (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) : undefined
  const own = ownHome ? (await $.fs.stat(`${ownHome}/${unsafe?.folder}`, { resolve: true }).catch(() => undefined))?.realPath : undefined
  const found = unsafe ? await foundAbove($, unsafe.folder, unsafe.harmless, own) : undefined
  if (unsafe && found) {
    const refused =
      found === 'unchecked'
        ? `${adapter.name} cannot run read-only here: this folder and those above it could not all be checked for ${unsafe.folder}, and ${unsafe.why}. ${anyway}`
        : `${adapter.name} cannot run read-only here: ${unsafe.why} (${found}). ${anyway}`
    return yield* respond(e, textChunks(refused), refused)
  }
  const guard = chosen.tools === 'read' ? await readOnlyGuard($, adapter) : undefined
  if (typeof guard === 'string') {
    const refused = `${adapter.name} cannot run read-only here: ${guard}. ${anyway}`
    return yield* respond(e, textChunks(refused), refused)
  }
  const ready = await relayReady(w, $, adapter, w.latest.has(adapter.name))
  if (typeof ready === 'string') return yield* respond(e, textChunks(ready), ready)
  const early = adapter.probe && !adapter.probe.after ? probeModel($, adapter, chosen) : undefined
  const probe = (latest: string | undefined) => early ?? (latest ? probeModel($, adapter, chosen, latest) : Promise.resolve(undefined))
  // Only this run's answer may answer a later step that runs nothing: an aborted run leaves none.
  await updateRecord(w, $, agentId, { report: '', handedBack: false })
  const abort = new AbortController()
  // The run keeps this step's `$` for its whole life, through later steps and tool calls.
  return {
    turnId: e.turnId,
    abort,
    held: [],
    outputs: new Map(),
    count: 0,
    gen: drive(w, $, {
      adapter,
      e,
      turn,
      agentId,
      record,
      prompt: asked.prompt,
      chosen,
      mode,
      installed: ready.installed,
      guard,
      probe,
      signal: abort.signal,
    }),
  }
}

// What one run needs, settled before it starts.
type Drive = {
  adapter: Adapter
  e: { turnId: string; index: number }
  turn: Turn
  agentId: string
  record: AgentRecord
  prompt: string
  chosen: Choice
  mode: Mode
  installed: string | undefined
  guard: Readonly<Record<string, string>> | undefined
  probe: (latest: string | undefined) => Promise<string | undefined>
  signal: AbortSignal
}

async function* drive(w: World, $: EngineInterface, d: Drive): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
  const { adapter, e, turn, agentId, record, chosen, mode, installed, guard, probe, signal } = d
  let prompt = d.prompt
  let block = 0
  let result: RunResult
  const models = chosen.model ? await cachedModels($, adapter, w.defaultModel) : []
  // An interrupted run is followed at once by its message, on the same session.
  for (;;) {
    const session = record.session
    const inbox = adapter.steer ? await openInbox($, adapter.name, agentId, w.inboxes) : undefined
    result = yield* run(w, adapter, $, {
      agentId,
      choice: chosen,
      prompt,
      signal,
      inbox,
      session,
      mode,
      installed,
      models,
      block,
      guard,
      probe,
      // Saved the moment the harness issues it: a reload mid-run must not lose the session.
      save: async (id) => {
        if (id !== session) await updateRecord(w, $, agentId, { session: id })
      },
    })
    if (result.next === undefined) break
    if (signal.aborted) return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
    prompt = result.next
    block = result.block
  }
  if (result.aborted) return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
  // The run has answered: a transcript that cannot be read must not cost the answer.
  const handback = await handbackOf($, agentId, record).catch(() => record.handback)
  turn.done = true
  await updateRecord(w, $, agentId, { report: result.signed, handedBack: handback })
  if (handback) return yield* deliver(adapter.name, e, result.block, result.signed, result.usage)
  return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: result.usage }], result.signed)
}
