import type { EngineInterface, Timer, TurnStepChunk, TurnUsage } from 'claude-code'
import type { Choice } from '../types'
import type { Mark } from './acp/steps'
import type { Adapter, Ask, Mode } from './adapter'
import { closeChildren, route } from './children'
import { stepOf } from './progress'
import { nearestModels } from './prompt'
import { helperOf, journalChildren } from './recovery'
import { finish, type Totals } from './report'
import type { Inbox } from './steer'
import { answerAsk, closeInbox, undeliveredSteers } from './steer'
import type { World } from './world'

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
  durable?: { path: string; recover: boolean; scope?: string }
  shownChildren?: ReadonlySet<string>
  complete?(result: RunResult): Promise<void>
}

const PLAN_MARKS: Record<string, string> = { pending: '☐', in_progress: '◐', completed: '☑' }

export async function* run(
  w: World,
  adapter: Adapter,
  $: Pick<EngineInterface, 'process' | 'clock' | 'plugin' | 'fs' | 'env' | 'ui'>,
  {
    agentId,
    choice,
    prompt,
    signal,
    inbox,
    session,
    block = 0,
    guard,
    mode,
    installed,
    models = [],
    probe,
    save,
    durable,
    complete,
    shownChildren,
  }: RunInput,
): AsyncGenerator<TurnStepChunk | Mark, RunResult> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const row = async (text: string) => {
    if (!home) return
    await $.fs.write(`${home}/.claude/via/rows/${agentId}.jsonl`, text).catch(() => {})
  }
  const description = stepOf(w.descriptions.get(agentId) ?? '')
  const named = description ? `${description} · ` : ''
  const request = () => adapter.start({ choice, prompt, session, agentId, root: $.plugin.root, inbox: inbox?.path, guard, mode, installed })
  let issued: string | undefined
  let latest = session
  let index = block - 1
  let kind: 'text' | 'thinking' | undefined
  let buffer = ''
  let stderr = ''
  let report = ''
  let answeredBy = ''
  const notices: string[] = []
  const parse = adapter.events(session)
  let failure = ''
  let error = ''
  let steered = 0
  let touched = false
  let childAt = 0
  const childScope = durable?.scope ?? agentId
  // A /compact prompt that compacted and said nothing has the compaction as its answer.
  const compacting = new Set<string>()
  let compacted = false
  const asks: Ask[] = []
  // Calls announced and not yet reported done: an interrupt or the run's end closes them as failed,
  // or their rows would stay running and via's tool.call hook would wait on them.
  const open = new Set<string>()
  const close = (why: string): Mark[] => {
    const marks = [...open].map((id): Mark => ({ kind: 'call-end', id, output: why, failed: true }))
    open.clear()
    return marks
  }
  const last: Totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const push = (k: 'text' | 'thinking', text: string): TurnStepChunk => {
    if (k !== kind) {
      kind = k
      index += 1
    }
    return { kind: k, index, text }
  }
  let plan = ''
  let plans = 0
  const usageNow = (): TurnUsage => ({
    model: answeredBy || adapter.name,
    input_tokens: last.input,
    output_tokens: last.output,
    cache_read_input_tokens: last.cacheRead,
    cache_creation_input_tokens: last.cacheWrite,
  })
  const take = (line: string): (TurnStepChunk | Mark)[] => {
    const chunks: (TurnStepChunk | Mark)[] = []
    for (const event of parse(line)) {
      switch (event.k) {
        case 'message':
          report = ''
          break
        case 'session':
          issued = event.id
          latest = event.id
          break
        case 'model':
          answeredBy = event.name
          break
        case 'usage':
          // Claude Code reads input + cache as the agent's context: report the last model call, never
          // the run's sum. Cost accuracy is traded away for that; the harness's own logs keep it.
          last.input = event.usage.input
          last.cacheRead = event.usage.cacheRead
          last.cacheWrite = event.usage.cacheWrite
          last.output = event.usage.output
          error = ''
          break
        case 'steered':
          steered += 1
          break
        case 'interrupted':
          // The harness ran the interrupt itself: nothing for the core to rerun or call undelivered.
          if (inbox) inbox.interrupt = undefined
          chunks.push(...close('interrupted'))
          break
        case 'ask':
          if (
            !durable?.recover ||
            !inbox?.lines.some((line) => {
              try {
                return JSON.parse(line)?.answer === event.ask.id
              } catch {
                return false
              }
            })
          )
            asks.push(event.ask)
          break
        case 'notice':
          notices.push(event.t)
          break
        case 'error':
          error = event.message
          break
        case 'text':
          report += event.t
          chunks.push(push('text', event.t))
          break
        case 'thinking':
          chunks.push(push('thinking', event.t))
          break
        case 'call': {
          open.add(event.id)
          if (event.kind === 'compact') compacting.add(event.id)
          if (durable?.recover) break
          kind = undefined
          const input = { kind: event.kind, title: event.title, ...(event.path ? { path: event.path } : {}) }
          chunks.push({ kind: 'call-start', id: event.id, input, usage: usageNow() })
          break
        }
        case 'plan': {
          if (durable?.recover) break
          // A row of its own, opened and closed at once, as Claude Code's own to-do list is: only on a change.
          const listed = event.entries.map((entry) => `${PLAN_MARKS[entry.status] ?? '☐'} ${entry.content}`).join('\n')
          if (listed === plan) break
          plan = listed
          kind = undefined
          plans += 1
          const id = `plan-${plans}`
          chunks.push({ kind: 'call-start', id, input: { kind: 'plan', title: 'Plan' }, usage: usageNow() })
          chunks.push({ kind: 'call-end', id, output: listed, failed: false })
          break
        }
        case 'called':
          if (!open.delete(event.id)) break
          if (compacting.has(event.id) && !event.failed) compacted = true
          if (durable?.recover) break
          chunks.push({ kind: 'call-end', id: event.id, output: event.output, failed: event.failed })
          break
        case 'child':
        case 'of': {
          // Only a spawn, a step of its own, ends the text block it falls in.
          const marks = durable?.recover
            ? journalChildren(w, durable.path, childScope, `${$.plugin.name}:${adapter.name}`, ++childAt, event)
                .pending.splice(0)
                .filter((mark) => mark.kind !== 'spawn' || !shownChildren?.has(mark.child))
            : route(w, childScope, `${$.plugin.name}:${adapter.name}`, event)
          if (marks.length > 0) kind = undefined
          chunks.push(...marks)
          break
        }
        case 'tool': {
          chunks.push(push('text', event.t))
          const tools = (w.activity.get(agentId)?.tools ?? 0) + 1
          w.activity.set(agentId, { step: stepOf(event.t), tools })
          touched = true
          break
        }
        default: {
          const unreachable: never = event
          return unreachable
        }
      }
    }
    return chunks
  }
  await row('')
  const child = $.process.spawn(
    durable
      ? {
          argv: ['node', helperOf($), durable.recover ? 'follow' : 'start', durable.path],
          ...(durable.recover ? {} : { input: JSON.stringify({ ...request(), timeoutMs: w.timeoutMinutes * 60_000 }) }),
        }
      : request(),
  )
  const pieces = child[Symbol.asyncIterator]()
  let timer: Timer | undefined
  let stopped: 'limit' | 'abort' | undefined
  let exited = false
  let terminal = false
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
      for (const line of lines) yield* take(line)
      // Asked without waiting: Esc, the time limit and an interrupt still reach the harness meanwhile.
      while (asks.length > 0) void answerAsk($, w.inboxes, agentId, inbox, asks.shift() as Ask, adapter.name)
      if (touched) {
        touched = false
        const activity = w.activity.get(agentId)
        if (activity !== undefined) {
          const content = `via:${adapter.name} · ${named}▸ ${activity.step} · ${activity.tools} ${activity.tools === 1 ? 'step' : 'steps'}`
          await row(`${JSON.stringify({ id: agentId, content })}\n`)
        }
      }
      if (issued !== undefined) {
        await save(issued)
        issued = undefined
      }
    }
    if (stopped === undefined) {
      yield* take(buffer)
      if (issued !== undefined) await save(issued)
      const exit = await child.result
      terminal = !durable || (exit.code !== null && exit.code !== 200)
      const known = adapter.failure?.(exit, stderr)
      if (known?.sessionLost) await save('')
      if (exit.code === 0 && !report.trim() && compacted && /^\/compact\b/.test(prompt.trim()) && known === undefined && !error)
        report = 'Compacted the conversation.'
      if (known !== undefined) failure = known.message
      else if (error) failure = `${adapter.name}'s model call failed: ${error}`
      else if (exit.code !== 0 || !report.trim()) {
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
      const tail = take(buffer)
      if (stopped === 'limit') yield* tail
      if (issued !== undefined) await save(issued)
    }
  } catch (err) {
    failure = `${adapter.name} could not run (is it installed and on PATH?): ${String(err)}`
  } finally {
    // An explicit stop cancels the worker and waits for its receipt. Unloading a follower preserves
    // the worker: its own deadline still applies, and the next process follows its journal.
    let cancelled = false
    if (!exited) {
      if (durable && (stopped !== undefined || signal.aborted))
        cancelled =
          (await $.process.run(['node', helperOf($), 'cancel', durable.path], { timeoutMs: 7500 }).catch(() => undefined))?.exitCode === 0
      void Promise.resolve(pieces.return?.(undefined as never)).catch(() => {})
    }
    timer?.cancel()
    w.activity.delete(agentId)
    // Its subagents ran in the harness: nothing more can come from them.
    const detached = durable && !terminal && !cancelled
    if (!detached) closeChildren(w, childScope, stopped === undefined ? undefined : 'the harness run was stopped')
    await row('')
    if (inbox && !detached) await closeInbox($, inbox, agentId, w.inboxes)
    else if (inbox) w.inboxes.delete(agentId)
  }
  yield* close(
    stopped === 'limit'
      ? `stopped at the ${w.timeoutMinutes}-minute limit`
      : stopped === 'abort'
        ? 'interrupted'
        : 'the run ended before this call finished',
  )

  if (stopped === 'abort') {
    const result = { aborted: true, signed: '', usage: null, block: index }
    await complete?.(result).catch(() => undefined)
    return result
  }

  // The abort's own failure is not the answer: the interrupt's message runs next, after the steers it cut off.
  // A run that finished before the abort, or hit the time limit, keeps its answer; the interrupt is undelivered.
  if (inbox?.interrupt !== undefined && failure && stopped === undefined) {
    yield push('text', '\n▸ interrupted\n')
    return {
      aborted: false,
      signed: '',
      usage: null,
      block: index + 1,
      next: [...undeliveredSteers(inbox, steered), inbox.interrupt].join('\n\n'),
    }
  }
  if (!answeredBy && !failure) answeredBy = (await probe(latest)) ?? ''
  const done = finish({
    adapter,
    choice,
    notices,
    stopped,
    timeoutMinutes: w.timeoutMinutes,
    report,
    answeredBy,
    failure,
    steered,
    inbox,
    total: last,
    push,
  })
  const result = { aborted: false, signed: done.signed, usage: done.usage, block: index + 1 }
  // The terminal receipt precedes the final text yield: a renderer can disappear at either yield.
  await complete?.(result).catch(() => undefined)
  yield* done.chunks
  return result
}
