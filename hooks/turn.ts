import type { EngineInterface, StreamHook, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Choice } from '../types'
import { endJob, type Job, type Mark, pump } from './acp/steps'
import type { Adapter, Mode } from './adapter'
import { childRun } from './children'
import { deliver, handbackAsked, respond, textChunks } from './handback'
import { cachedModels } from './models'
import { helpOf, isModel, promptOf } from './prompt'
import { answerOf, answerPath, attachChild, keepSpawn, type Receipt, remember, roster } from './recovery'
import { cutOff, type RunResult, run } from './run'
import { openInbox } from './steer'

export { remember } from './recovery'

import type { World } from './world'

type StepHook = StreamHook<'turn.step'>

export async function adapterOf(w: World, $: Parameters<StepHook>[0], agentId: string): Promise<Adapter | undefined> {
  if (w.others.has(agentId)) return undefined
  const known = w.agents.get(agentId)
  if (known) {
    if (!w.nested.has(agentId)) {
      const kept = (await roster($))[agentId]
      if (kept?.nested) w.nested.set(agentId, { key: kept.nested.key })
    }
    return known
  }
  // Ahead of agent.list: the new process of a session sent to the background resumes the agent as
  // general-purpose. Its step would go to Claude under the harness's model name.
  const kept = (await roster($))[agentId]
  const remembered = kept ? w.adapters.get(kept.harness) : undefined
  if (remembered) {
    w.agents.set(agentId, remembered)
    if (kept?.nested) w.nested.set(agentId, { key: kept.nested.key })
    return remembered
  }
  const agent = (await $.agent.list()).find((a) => a.id === agentId)
  // Not listed yet: decide on a later step rather than caching a guess.
  if (agent === undefined) return undefined
  const [plugin, name = ''] = agent.type.split(':')
  const adapter = plugin === $.plugin.name ? w.adapters.get(name) : undefined
  if (adapter) w.agents.set(agentId, adapter)
  else w.others.add(agentId)
  return adapter
}

// Persisted first: a reload forgets the map but not the decision.
async function handbackOf(w: World, $: Parameters<StepHook>[0], agentId: string): Promise<boolean> {
  const saved = (await $.state.get({ plugin: 'via', key: 'handbacks', id: agentId })).value
  if (saved === true || w.handbacks.get(agentId) === true || (await handbackAsked($, agentId))) return true
  return (await roster($))[agentId]?.handback === true
}

// Walks up from the session's folder: relative paths resolve there, and the root is its own parent.
// Says `unchecked` when it cannot finish (a stat refused, or a hook withheld realPath): not proven clean.
async function foundAbove(
  $: Parameters<StepHook>[0],
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

async function probeModel($: Parameters<StepHook>[0], adapter: Adapter, choice: Choice, session?: string): Promise<string | undefined> {
  if (!adapter.probe) return undefined
  const env = adapter.probe.env?.(choice)
  const asked = await $.process
    .run(adapter.probe.argv(choice, session), { timeoutMs: 15_000, ...(env ? { env } : {}) })
    .catch(() => undefined)
  return asked?.exitCode === 0 ? adapter.probe.model(asked.stdout) : undefined
}

// Type stripping, which runs relay/relay.mjs and mcp/step.mts as is, is on by default from Node 22.18.
const nodeOk = (version: string) => {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 18)
}

// Every harness needs Node, for the step server that reports its tool calls, and the relay too; an ACP
// adapter that installs needs its pinned copy, installed once. A string says why the run cannot start.
async function relayReady(w: World, $: Parameters<StepHook>[0], adapter: Adapter): Promise<{ installed?: string } | string> {
  w.node ??= $.process.run(['node', '-p', 'process.versions.node'], { timeoutMs: 15_000 }).then(
    (r) => (r.exitCode === 0 ? r.stdout.trim() : undefined),
    () => undefined,
  )
  const version = await w.node
  if (!version || !nodeOk(version))
    return `via needs Node 22.18 or later on PATH to run ${adapter.name}${version ? `, not ${version}` : ''}. Install a current Node LTS and restart Claude Code.`
  if (!adapter.relay) return {}
  const install = adapter.relay.install
  if (!install) return {}
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) return `${adapter.name} needs a home folder to install ${install.dir} into.`
  const latest = w.codexAcp === 'latest'
  const dir = `${home}/.claude/via/acp/${latest ? 'latest' : install.dir}`
  const entry = `${dir}/${install.entry}`
  let installing = w.installs.get(dir)
  if (!installing) {
    installing = (async () => {
      // In via's own folder, so a project's .npmrc never applies; no install scripts, and no Codex binary:
      // codex-acp is pointed at the person's own codex.
      const flags = ['--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund']
      let argv: string[]
      if (latest) {
        // The newest, once per Claude Code session, unpinned: the person chose upstream over review.
        await $.fs.write(`${dir}/package.json`, '{ "private": true }\n')
        argv = ['npm', 'install', ...flags, `${install.package}@latest`]
      } else {
        if (
          await $.fs.stat(entry).then(
            (s) => s.kind === 'file',
            () => false,
          )
        )
          return entry
        for (const file of install.files) await $.fs.write(`${dir}/${file.split('/').at(-1)}`, await $.fs.read(`${$.plugin.root}/${file}`))
        // Exactly the locked tree, each package's integrity checked by npm.
        argv = ['npm', 'ci', ...flags]
      }
      const done = await $.process
        .run(argv, { cwd: dir, timeoutMs: 300_000 })
        .catch((error: unknown) => ({ exitCode: -1, stderr: String(error) }))
      // Offline, latest keeps the newest it installed before rather than refusing.
      if (
        done.exitCode !== 0 &&
        latest &&
        (await $.fs.stat(entry).then(
          (s) => s.kind === 'file',
          () => false,
        ))
      )
        return entry
      if (done.exitCode !== 0) throw new Error(done.stderr.trim().split('\n').slice(-3).join(' ') || `npm ci exited with ${done.exitCode}`)
      return entry
    })()
    w.installs.set(dir, installing)
  }
  return installing.then(
    (installed) => ({ installed }),
    (error: unknown) => {
      w.installs.delete(dir)
      return `${adapter.name} could not install ${install.dir} (npm ci): ${String((error as { message?: unknown })?.message ?? error)}`
    },
  )
}

// A guard that cannot prove a read-only run safe refuses it; the string says why.
async function readOnlyGuard($: Parameters<StepHook>[0], adapter: Adapter): Promise<Readonly<Record<string, string>> | string | undefined> {
  const guard = adapter.readOnlyGuard
  if (!guard) return undefined
  const listed = await $.process.run(guard.argv, { timeoutMs: 15_000 }).catch(() => undefined)
  return (listed?.exitCode === 0 ? guard.env(listed.stdout) : undefined) ?? guard.why
}

// A nested agent's steps: its harness subagent's rows and answer, read from its parent's run.
async function* nestedStep(
  w: World,
  $: Parameters<StepHook>[0],
  e: Parameters<StepHook>[1],
  agentId: string,
  adapter: Adapter,
  nested: { key: string; report?: string },
  signal: AbortSignal,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  // session.append makes a native user row without submitting another task or steering Codex twice.
  const user = async (text: string) => {
    await $.session.append({ agentId, message: { type: 'user', content: [{ type: 'text', text }] } })
  }
  const job = w.jobs.get(agentId)
  if (job !== undefined) return yield* pump(w, job, e, signal, () => $.viaSteps.wait({ agentId }), user)
  if (nested.report !== undefined) return yield* retained(w, $, adapter, e, agentId, nested.report)
  const kept = (await roster($))[agentId]
  const receipt = kept?.nested?.run ?? (kept?.nested ? (await roster($))[kept.nested.parent]?.run : undefined)
  if (receipt) {
    const saved = await answerOf($, answerPath(receipt, nested.key))
    if (saved && !saved.aborted && saved.signed.trim()) nested.report = saved.signed
    else if (kept?.nested) await attachChild(w, $, adapter, nested.key, kept.nested.parent, receipt)
  }
  // After its handback, or a later message: the answer again, as text.
  if (nested.report !== undefined) return yield* retained(w, $, adapter, e, agentId, nested.report)
  const abort = new AbortController()
  const handback = await handbackOf(w, $, agentId)
  const started: Job = {
    turnId: e.turnId,
    gen: nestedRun(
      w,
      $,
      agentId,
      adapter.name,
      e,
      abort.signal,
      handback,
      receipt
        ? (signed) =>
            $.fs.write(answerPath(receipt, nested.key), JSON.stringify({ signed, aborted: abort.signal.aborted, usage: null, block: 0 }))
        : undefined,
    ),
    held: [],
    outputs: new Map(),
    abort,
    count: 0,
  }
  w.jobs.set(agentId, started)
  return yield* pump(w, started, e, signal, () => $.viaSteps.wait({ agentId }), user)
}

async function* nestedRun(
  w: World,
  $: Parameters<StepHook>[0],
  agentId: string,
  name: string,
  e: { turnId: string; index: number },
  signal: AbortSignal,
  handback: boolean,
  complete?: (signed: string) => Promise<void>,
): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
  const result = yield* childRun(w, $, agentId, name, e, signal, handback, complete)
  if (result.toolUses.some((tool) => tool.name === 'SubagentHandback'))
    await $.state.set({ plugin: 'via', key: 'handedBack', id: agentId }, true)
  return result
}

// A run outlives the step that started it: each harness tool call ends a step with a call to via's
// tool, whose tool.call hook reads the run on until the harness finishes that call (answerCall), and
// the next step reads on from there. Whichever hook reads the run lends it its abort signal.
export async function* turnStep(w: World, $: Parameters<StepHook>[0], e: Parameters<StepHook>[1], next: Parameters<StepHook>[2]) {
  const agentId = e.agentId
  if (agentId === undefined) return yield* next(e)
  const adapter = await adapterOf(w, $, agentId)
  if (adapter === undefined) return yield* next(e)
  w.keepSpawn = (id, key) => keepSpawn(w, $, id, key)
  const nested = w.nested.get(agentId)
  if (nested !== undefined) return yield* nestedStep(w, $, e, agentId, adapter, nested, next.signal)
  const job = w.jobs.get(agentId)
  if (job !== undefined) {
    const turn = w.turns.get(e.turnId)
    if (job.turnId === e.turnId || turn === undefined || turn.wake)
      return yield* pump(w, job, e, next.signal, () => $.viaSteps.wait({ agentId }))
    endJob(w, agentId)
  }
  const started = yield* begin(w, adapter, $, e, agentId)
  if (started === undefined) return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
  if ('answer' in started) return started
  w.jobs.set(agentId, started)
  return yield* pump(w, started, e, next.signal, () => $.viaSteps.wait({ agentId }))
}

// Everything before the run: refusals answer at once; otherwise the run as a job.
async function* begin(
  w: World,
  adapter: Adapter,
  $: Parameters<StepHook>[0],
  e: Parameters<StepHook>[1],
  agentId: string,
): AsyncGenerator<TurnStepChunk, TurnStepResult | Job | undefined> {
  const turn = w.turns.get(e.turnId)
  const receipt = (await roster($))[agentId]?.run
  if (receipt && (turn === undefined || turn.wake || receipt.turnId === e.turnId)) {
    const saved = await answerOf($, answerPath(receipt))
    if (saved && !saved.aborted && saved.signed.trim()) return yield* retained(w, $, adapter, e, agentId, saved.signed)
    if (!saved?.aborted) {
      const abort = new AbortController()
      return {
        turnId: e.turnId,
        gen: recovered(w, $, adapter, e, agentId, receipt, abort.signal),
        held: [],
        outputs: new Map(),
        abort,
        count: 0,
      }
    }
  }
  if (turn === undefined || turn.wake) {
    // A compaction can take a step with no turn.start: keep the agent's real answer, not the stub.
    // Claude Code takes the last text as the result even after a handback, so a delivered report is
    // repeated as text, and only an undelivered one is handed back.
    const saved = (await $.state.get({ plugin: 'via', key: 'reports', id: agentId })).value
    if (saved) {
      const handed = (await $.state.get({ plugin: 'via', key: 'handedBack', id: agentId })).value === true
      if (!handed && (await handbackOf(w, $, agentId))) {
        await $.state.set({ plugin: 'via', key: 'handedBack', id: agentId }, true)
        return yield* deliver(adapter.name, e, { prompt: '', report: saved, delivered: false }, 0, saved, null)
      }
      return yield* respond(e, textChunks(saved), saved)
    }
    // This hook runs, so via is loaded: the turn was lost, in a session sent to the background (its new
    // process resumes the agent without a turn.start) or a reload mid-run, not never run.
    // Handed back once: the step after the handback has no turn either, and must not hand back again.
    const said = cutOff(adapter.name)
    const handed = (await $.state.get({ plugin: 'via', key: 'handedBack', id: agentId })).value === true
    if (!handed && (await handbackOf(w, $, agentId))) {
      await $.state.set({ plugin: 'via', key: 'handedBack', id: agentId }, true)
      return yield* deliver(adapter.name, e, { prompt: '', report: said, delivered: false }, 0, said, null)
    }
    return yield* respond(e, textChunks(said), said)
  }
  if (turn.delivered) return yield* respond(e, textChunks(turn.report ?? ''), turn.report ?? '')
  if (turn.report !== undefined) {
    await $.state.set({ plugin: 'via', key: 'handedBack', id: agentId }, true)
    return yield* deliver(adapter.name, e, turn, 0, turn.report, null)
  }

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

  const ref = { plugin: 'via', key: 'agents', id: agentId } as const
  const held = await $.state.get(ref)
  const merged: Choice = {
    ...held.value,
    ...(asked.model ? { model: asked.model } : {}),
    ...(asked.tools ? { tools: asked.tools } : {}),
    ...(asked.thinking ? { thinking: asked.thinking } : {}),
    ...(asked.tier ? { tier: asked.tier } : {}),
  }
  const changed =
    merged.model !== held.value?.model ||
    merged.tools !== held.value?.tools ||
    merged.thinking !== held.value?.thinking ||
    merged.tier !== held.value?.tier
  if (changed) await $.state.set(ref, merged)

  // What the person allows Claude itself, as the spawn carried it: plan mode is read-only here too.
  const mode = (w.modes.get(agentId) ?? (await $.state.get({ plugin: 'via', key: 'modes', id: agentId })).value ?? 'default') as Mode
  const withModel: Choice = merged.model ? merged : { ...merged, ...(defaultModel ? { model: defaultModel } : {}) }
  if (mode === 'plan' && adapter.readOnly === 'none') {
    const refused = `${adapter.name} cannot run in plan mode: it has no read-only mode that via can enforce. Leave plan mode to run it, or ask a harness that can enforce read-only.`
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
        ? `${adapter.name} cannot run read-only here: this folder and those above it could not all be checked for ${unsafe.folder}, and ${unsafe.why}. To run it anyway, start a new agent without \`tools: read\`, outside plan mode; or ask a harness that can enforce read-only.`
        : `${adapter.name} cannot run read-only here: ${unsafe.why} (${found}). To run it anyway, start a new agent without \`tools: read\`, outside plan mode; or ask a harness that can enforce read-only.`
    return yield* respond(e, textChunks(refused), refused)
  }
  const guard = chosen.tools === 'read' ? await readOnlyGuard($, adapter) : undefined
  if (typeof guard === 'string') {
    const refused = `${adapter.name} cannot run read-only here: ${guard}. To run it anyway, start a new agent without \`tools: read\`, outside plan mode; or ask a harness that can enforce read-only.`
    return yield* respond(e, textChunks(refused), refused)
  }
  const ready = await relayReady(w, $, adapter)
  if (typeof ready === 'string') return yield* respond(e, textChunks(ready), ready)
  const early = adapter.probe && !adapter.probe.after ? probeModel($, adapter, chosen) : undefined
  const probe = (latest: string | undefined) => early ?? (latest ? probeModel($, adapter, chosen, latest) : Promise.resolve(undefined))
  // Only this run's report may answer a later no-turn step: an aborted run leaves none.
  await $.state.set({ plugin: 'via', key: 'reports', id: agentId }, '')
  await $.state.set({ plugin: 'via', key: 'handedBack', id: agentId }, false)
  const abort = new AbortController()
  // The run keeps this step's `$` for its whole life, through later steps and tool calls.
  const job: Job = {
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
      prompt: asked.prompt,
      chosen,
      mode,
      installed: ready.installed,
      guard,
      probe,
      signal: abort.signal,
    }),
  }
  return job
}

// Reports and journals are reconciled before the missing-turn fallback. Following replays data only;
// the worker that owns the command admits it exactly once, even after the Claude process has exited.
async function* retained(
  w: World,
  $: Parameters<StepHook>[0],
  adapter: Adapter,
  e: { turnId: string; index: number },
  agentId: string,
  signed: string,
) {
  const handed = (await $.state.get({ plugin: 'via', key: 'handedBack', id: agentId })).value === true
  if (!handed && (await handbackOf(w, $, agentId))) {
    await $.state.set({ plugin: 'via', key: 'handedBack', id: agentId }, true)
    return yield* deliver(adapter.name, e, { prompt: '', report: signed, delivered: false }, 0, signed, null)
  }
  return yield* respond(e, textChunks(signed), signed)
}
async function* recovered(
  w: World,
  $: EngineInterface,
  adapter: Adapter,
  e: { turnId: string; index: number },
  agentId: string,
  receipt: Receipt,
  signal: AbortSignal,
): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
  const inbox = receipt.inbox
    ? { name: adapter.name, path: receipt.inbox, lines: (await $.fs.read(receipt.inbox).catch(() => '')).split('\n').filter(Boolean) }
    : undefined
  if (inbox) w.inboxes.set(agentId, inbox)
  const result = yield* run(w, adapter, $, {
    agentId,
    choice: receipt.choice,
    prompt: receipt.compact ? '/compact' : '',
    signal,
    inbox,
    session: receipt.session,
    guard: undefined,
    mode: receipt.mode,
    durable: { path: receipt.path, scope: receipt.scope, recover: true },
    shownChildren: new Set([
      ...Object.values(await roster($)).flatMap((kept) => (kept.nested ? [kept.nested.key] : [])),
      ...Object.values(receipt.spawns ?? {}),
    ]),
    complete: (result) => $.fs.write(answerPath(receipt), JSON.stringify(result)),
    probe: async () => undefined,
    save: async (id) => {
      await $.state.set({ plugin: 'via', key: 'sessions', id: agentId }, id)
    },
  })
  if (result.aborted) return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
  const signed =
    result.next === undefined
      ? result.signed
      : `The retained ${adapter.name} run stopped before its pending interrupt could run.\n\nPending message:\n${result.next}`
  if (result.next !== undefined) await $.fs.write(answerPath(receipt), JSON.stringify({ ...result, signed })).catch(() => undefined)
  await $.state.set({ plugin: 'via', key: 'reports', id: agentId }, signed)
  return yield* retained(w, $, adapter, e, agentId, signed)
}

// What one run needs, settled before it starts.
type Drive = {
  adapter: Adapter
  e: { turnId: string; index: number }
  turn: NonNullable<ReturnType<World['turns']['get']>>
  agentId: string
  prompt: string
  chosen: Choice
  mode: Mode
  installed: string | undefined
  guard: Readonly<Record<string, string>> | undefined
  probe: (latest: string | undefined) => Promise<string | undefined>
  signal: AbortSignal
}

async function* drive(w: World, $: EngineInterface, d: Drive): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
  const { adapter, e, turn, agentId, chosen, mode, installed, guard, probe, signal } = d
  let prompt = d.prompt
  let block = 0
  let result: RunResult
  const models = chosen.model ? await cachedModels($, adapter, w.defaultModel) : []
  // An interrupted run is followed at once by its message, on the same session.
  for (;;) {
    const session = (await $.state.get({ plugin: 'via', key: 'sessions', id: agentId })).value
    const inbox = adapter.steer ? await openInbox($, adapter.name, agentId, w.inboxes) : undefined
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    const receipt: Receipt | undefined = home
      ? {
          turnId: e.turnId,
          path: `${home}/.claude/via/runs/${encodeURIComponent(agentId)}/${encodeURIComponent(e.turnId)}/${block}`,
          scope: `${agentId}/${encodeURIComponent(e.turnId)}-${block}`,
          choice: chosen,
          mode,
          session,
          ...(inbox ? { inbox: inbox.path } : {}),
          ...(/^\/compact\b/.test(prompt.trim()) ? { compact: true } : {}),
        }
      : undefined
    if (receipt) await remember(w, $, agentId, { harness: adapter.name, handback: await handbackOf(w, $, agentId), run: receipt })
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
      ...(receipt
        ? {
            durable: { path: receipt.path, scope: receipt.scope, recover: false },
            complete: (result: RunResult) => $.fs.write(answerPath(receipt), JSON.stringify(result)),
          }
        : {}),
      // Saved the moment the harness issues it: a reload mid-run must not lose the session.
      save: async (id) => {
        if (id !== session) await $.state.set({ plugin: 'via', key: 'sessions', id: agentId }, id)
      },
    })
    if (result.next === undefined) break
    if (signal.aborted) return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
    prompt = result.next
    block = result.block
  }
  if (result.aborted) return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], '')
  const handback = await handbackOf(w, $, agentId)
  turn.report = result.signed
  await $.state.set({ plugin: 'via', key: 'reports', id: agentId }, result.signed)
  await $.state.set({ plugin: 'via', key: 'handedBack', id: agentId }, handback)
  if (handback) return yield* deliver(adapter.name, e, turn, result.block, result.signed, result.usage)
  return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: result.usage }], result.signed)
}
