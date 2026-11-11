import type { EngineInterface, Timer, TurnStepChunk, TurnUsage } from 'claude-code'
import type { Choice } from '../types'
import type { Norm } from './acp/norm'
import type { Mark } from './acp/steps'
import type { Adapter, Ask, Mode } from './adapter'
import { closeChildren, route } from './children'
import { stepOf } from './progress'
import { nearestModels } from './prompt'
import { finish, type Totals } from './report'
import type { Inbox } from './steer'
import { answerAsk, closeInbox, undeliveredSteers } from './steer'
import type { World } from './world'
import { StepWriter } from './writer'

const ANSI = /\u001b\[[0-9;]*m/g
const MISSING_MODEL = /refused model|model.*not found|not found.*model|unknown model|invalid model|no such model|model.*does not exist/i
export const notActive = (name: string) =>
  `The via plugin did not run this task, so ${name} did not answer it. Check the plugin is loaded in /plugin and restart Claude Code.`
export const cutOff = (name: string) =>
  `This ${name} run was cut off before it answered, as happens when the session is sent to the background. Send the task again to run it.`
export const notActivePrompt = (name: string) =>
  `You are not ${name}: this plugin did not take this step. Use no tools and do not attempt the task. Reply with exactly this and nothing else:\n\n${notActive(name)}`
// interrupted: an `interrupt:` message aborted the harness on purpose; next is what to run in its place.
export type RunResult = { aborted: boolean; signed: string; usage: TurnUsage | null; block: number; next?: string }
export type RunInput = {
  agentId: string
  choice: Choice
  prompt: string
  signal: AbortSignal
  inbox: Inbox | undefined
  session: string | undefined
  block?: number // the first content block, after an interrupted run's
  guard: Readonly<Record<string, string>> | undefined
  mode: Mode
  installed?: string
  models?: readonly string[] // the harness's offered models, for a refused model's nearest
  // Awaited only to sign, so a probe never delays the run or outlives an interrupted one.
  probe(session: string | undefined): Promise<string | undefined>
  save(session: string): Promise<void>
}

const PLAN_MARKS: Record<string, string> = { pending: '☐', in_progress: '◐', completed: '☑' }

// What a run has heard so far, as the harness's events come in.
type RunState = {
  readonly writer: StepWriter
  issued?: string // a session id the harness just issued, not yet saved
  latest: string | undefined // the run's session: the one it resumed, or the one it issued
  answeredBy: string
  readonly notices: string[]
  error: string
  steered: number
  touched: boolean // a tool line moved the panel row on
  readonly compacting: Set<string>
  compacted: boolean // a /compact prompt that compacted and said nothing has the compaction as its answer
  readonly asks: Ask[]
  readonly open: Set<string> // calls announced and not yet reported done
  readonly last: Totals // the last model call's usage: Claude Code reads input + cache as the agent's context
  plan: string
  plans: number
}
type Context = { readonly w: World; readonly agentId: string; readonly adapter: Adapter; readonly type: string; readonly inbox?: Inbox }

const usageOf = (s: RunState, adapter: Adapter): TurnUsage => ({
  model: s.answeredBy || adapter.name,
  input_tokens: s.last.input,
  output_tokens: s.last.output,
  cache_read_input_tokens: s.last.cacheRead,
  cache_creation_input_tokens: s.last.cacheWrite,
})

// Calls announced and not reported done: an interrupt or the run's end closes them as failed, or their rows
// would stay running and via's tool.call hook would wait on them.
function closeOpen(s: RunState, why: string): Mark[] {
  const marks = [...s.open].map((id): Mark => ({ kind: 'call-end', id, output: why, failed: true }))
  s.open.clear()
  return marks
}

// One event of the harness's, into the run's state and what it shows.
function take(s: RunState, c: Context, event: Norm): (TurnStepChunk | Mark)[] {
  switch (event.k) {
    case 'message':
      s.writer.message()
      return []
    case 'session':
      s.issued = event.id
      s.latest = event.id
      return []
    case 'model':
      s.answeredBy = event.name
      return []
    case 'usage':
      // The last model call, never the run's sum: cost accuracy is traded for a right context size.
      Object.assign(s.last, event.usage)
      s.error = ''
      return []
    case 'steered':
      s.steered += 1
      return []
    case 'interrupted':
      // The harness ran the interrupt itself: nothing for the core to rerun or call undelivered.
      if (c.inbox) c.inbox.interrupt = undefined
      return closeOpen(s, 'interrupted')
    case 'ask':
      s.asks.push(event.ask)
      return []
    case 'notice':
      s.notices.push(event.t)
      return []
    case 'error':
      s.error = event.message
      return []
    case 'text':
      return [s.writer.text(event.t)]
    case 'thinking':
      return [s.writer.thinking(event.t)]
    case 'call': {
      s.open.add(event.id)
      if (event.kind === 'compact') s.compacting.add(event.id)
      const input = { kind: event.kind, title: event.title, ...(event.path ? { path: event.path } : {}) }
      return [s.writer.call(event.id, input, usageOf(s, c.adapter))]
    }
    case 'plan': {
      // A row of its own, opened and closed at once, as Claude Code's own to-do list is: only on a change.
      const listed = event.entries.map((entry) => `${PLAN_MARKS[entry.status] ?? '☐'} ${entry.content}`).join('\n')
      if (listed === s.plan) return []
      s.plan = listed
      s.plans += 1
      const id = `plan-${s.plans}`
      return [
        s.writer.call(id, { kind: 'plan', title: 'Plan' }, usageOf(s, c.adapter)),
        { kind: 'call-end', id, output: listed, failed: false },
      ]
    }
    case 'called':
      if (!s.open.delete(event.id)) return []
      if (s.compacting.has(event.id) && !event.failed) s.compacted = true
      return [{ kind: 'call-end', id: event.id, output: event.output, failed: event.failed }]
    case 'child':
    case 'of': {
      // Only a spawn, a step of its own, ends the text block it falls in.
      const marks = route(c.w, c.agentId, c.type, event)
      if (marks.length > 0) s.writer.boundary()
      return marks
    }
    case 'tool': {
      const tools = (c.w.activity.get(c.agentId)?.tools ?? 0) + 1
      c.w.activity.set(c.agentId, { step: stepOf(event.t), tools })
      s.touched = true
      return [s.writer.say(event.t)]
    }
    default: {
      const unreachable: never = event
      return unreachable
    }
  }
}

export async function* run(
  w: World,
  adapter: Adapter,
  $: Pick<EngineInterface, 'process' | 'clock' | 'plugin' | 'fs' | 'env' | 'ui'>,
  { agentId, choice, prompt, signal, inbox, session, block = 0, guard, mode, installed, models = [], probe, save }: RunInput,
): AsyncGenerator<TurnStepChunk | Mark, RunResult> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const row = async (text: string) => {
    if (!home) return
    await $.fs.write(`${home}/.claude/via/rows/${agentId}.jsonl`, text).catch(() => {})
  }
  const description = stepOf(w.records.get(agentId)?.description ?? '')
  const named = description ? `${description} · ` : ''
  const request = adapter.start({ choice, prompt, session, agentId, root: $.plugin.root, inbox: inbox?.path, guard, mode, installed })
  const s: RunState = {
    writer: new StepWriter(block),
    latest: session,
    answeredBy: '',
    notices: [],
    error: '',
    steered: 0,
    touched: false,
    compacting: new Set(),
    compacted: false,
    asks: [],
    open: new Set(),
    last: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    plan: '',
    plans: 0,
  }
  const c: Context = { w, agentId, adapter, type: `${$.plugin.name}:${adapter.name}`, ...(inbox ? { inbox } : {}) }
  const parse = adapter.events(session)
  const takeLine = (line: string) => parse(line).flatMap((event) => take(s, c, event))
  let buffer = ''
  let stderr = ''
  let failure = ''
  await row('')
  const child = $.process.spawn(request)
  const pieces = child[Symbol.asyncIterator]()
  let timer: Timer | undefined
  let stopped: 'limit' | 'abort' | undefined
  let exited = false
  try {
    const until = new Promise<'limit' | 'abort'>((resolve) => {
      if (signal.aborted) resolve('abort')
      else signal.addEventListener('abort', () => resolve('abort'), { once: true })
      timer = $.clock.after(w.timeoutMinutes * 60_000, () => resolve('limit'))
    })
    for (;;) {
      const first = await Promise.race([
        pieces.next().then((piece) => ({ kind: 'piece' as const, piece })),
        until.then((why) => ({ kind: why })),
      ])
      if (first.kind !== 'piece') {
        stopped = first.kind
        break
      }
      if (first.piece.done) {
        exited = true
        break
      }
      const piece = first.piece.value
      if (piece.stream === 'stderr') {
        stderr += piece.text
        continue
      }
      buffer += piece.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) yield* takeLine(line)
      // Asked without waiting: Esc, the time limit and an interrupt still reach the harness meanwhile.
      while (s.asks.length > 0) void answerAsk($, w.inboxes, agentId, inbox, s.asks.shift() as Ask, adapter.name)
      if (s.touched) {
        s.touched = false
        const activity = w.activity.get(agentId)
        if (activity !== undefined) {
          const content = `via:${adapter.name} · ${named}▸ ${activity.step} · ${activity.tools} ${activity.tools === 1 ? 'step' : 'steps'}`
          await row(`${JSON.stringify({ id: agentId, content })}\n`)
        }
      }
      if (s.issued !== undefined) {
        await save(s.issued)
        s.issued = undefined
      }
    }
    if (stopped === undefined) {
      yield* takeLine(buffer)
      if (s.issued !== undefined) await save(s.issued)
      const exit = await child.result
      const known = adapter.failure?.(exit, stderr)
      if (known?.sessionLost) await save('')
      if (
        exit.code === 0 &&
        !s.writer.report.trim() &&
        s.compacted &&
        /^\/compact\b/.test(prompt.trim()) &&
        known === undefined &&
        !s.error
      )
        s.writer.report = 'Compacted the conversation.'
      if (known !== undefined) failure = known.message
      else if (s.error) failure = `${adapter.name}'s model call failed: ${s.error}`
      else if (exit.code !== 0 || !s.writer.report.trim()) {
        const why = stderr.replace(ANSI, '').trim() || '(no stderr)'
        failure =
          exit.code !== 0
            ? `${adapter.name} exited with ${exit.code ?? exit.signal}.\n${why}`
            : `${adapter.name} ended with no answer.\n${why}`
      }
      // Only a model the harness turned away, and not one it offers: a rate limit naming a good model is not that.
      const refused =
        choice.model &&
        !models.includes(choice.model) &&
        failure.toLowerCase().includes(choice.model.toLowerCase()) &&
        MISSING_MODEL.test(failure)
      const near = refused && choice.model ? nearestModels(choice.model, models) : []
      if (near.length > 0) failure += `\nDid you mean ${near.join(', ')}?`
    } else {
      const tail = takeLine(buffer)
      if (stopped === 'limit') yield* tail
      if (s.issued !== undefined) await save(s.issued)
    }
  } catch (err) {
    failure = `${adapter.name} could not run (is it installed and on PATH?): ${String(err)}`
  } finally {
    // However the run ends, its harness ends with it: a limit, an Esc, or a step no hook reads on. Not
    // awaited, so a child slow to go cannot hold up the rest.
    if (!exited) void Promise.resolve(pieces.return?.(undefined as never)).catch(() => {})
    timer?.cancel()
    w.activity.delete(agentId)
    // Its subagents ran in the harness: nothing more can come from them.
    closeChildren(w, agentId, stopped === undefined ? undefined : 'the harness run was stopped')
    await row('')
    if (inbox) await closeInbox($, inbox, agentId, w.inboxes)
  }
  yield* closeOpen(
    s,
    stopped === 'limit'
      ? `stopped at the ${w.timeoutMinutes}-minute limit`
      : stopped === 'abort'
        ? 'interrupted'
        : 'the run ended before this call finished',
  )

  if (stopped === 'abort') return { aborted: true, signed: '', usage: null, block: s.writer.index }

  // The abort's own failure is not the answer: the interrupt's message runs next, after the steers it cut off.
  // A run that finished before the abort, or hit the time limit, keeps its answer; the interrupt is undelivered.
  if (inbox?.interrupt !== undefined && failure && stopped === undefined) {
    yield s.writer.say('\n▸ interrupted\n')
    return {
      aborted: false,
      signed: '',
      usage: null,
      block: s.writer.index + 1,
      next: [...undeliveredSteers(inbox, s.steered), inbox.interrupt].join('\n\n'),
    }
  }
  if (!s.answeredBy && !failure) s.answeredBy = (await probe(s.latest)) ?? ''
  const done = finish({
    adapter,
    choice,
    notices: s.notices,
    stopped,
    timeoutMinutes: w.timeoutMinutes,
    report: s.writer.report,
    answeredBy: s.answeredBy,
    failure,
    steered: s.steered,
    inbox,
    total: s.last,
    writer: s.writer,
  })
  yield* done.chunks
  return { aborted: false, signed: done.signed, usage: done.usage, block: s.writer.index + 1 }
}
