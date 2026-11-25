import type { Timer, TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'
import type { Question } from './norm'
import { NO_OUTPUT } from './render'

// One step per harness tool call. A run outlives the step that started it: each tool call the
// harness reports ends a step with a call to the plugin's own tool, whose tool.call hook (answerCall)
// reads the run on until the harness reports that call done, and the next step (pump) reads on
// from there. The tool runs nothing: a call to it nobody answers fails, where a Bash call whose hook
// failed would run the real command.

// A harness tool call starting or ending, for pump to make a call to the plugin's tool of; never reaches the engine.
// usage: the run's last model call, for the step that ends with the call.
export type Mark =
  | { kind: 'call-start'; id: string; input: CallInput; usage: TurnUsage | null }
  | { kind: 'call-end'; id: string; output: string; failed: boolean }
  // A question no longer needing an answer: the hook waiting on the person for it stops.
  | { kind: 'question-closed'; id: string }
  // A harness's subagent to show as an agent nested under this one: the step calls the Agent tool.
  | { kind: 'spawn'; child: string; type: string; title: string; prompt?: string }
  // A message from this agent to another, such as a question handed to the main agent: the step calls SendMessage.
  // question: the handed question it carries, sent only while that question heads the line.
  | { kind: 'send'; to: string; summary: string; message: string; question?: string }
export type Send = Extract<Mark, { kind: 'send' }>
// What a step call carries: the harness's call, or its question to the person, which the call's hook asks.
export type CallInput = { kind: string; title: string; path?: string; question?: Question }

// A harness run that outlives its step: steps and the tool's tool.call hook take turns reading it.
// held: what a tool.call hook read past its call, for the next step; outputs: finished calls by the
// harness's id; final: the run's last step, once it ended.
export type Job = {
  turnId: string
  gen: AsyncGenerator<TurnStepChunk | Mark, TurnStepResult>
  held: (TurnStepChunk | Mark)[]
  outputs: Map<string, { output: string; failed: boolean }>
  final?: TurnStepResult
  abort: AbortController
  count: number
  // The generator's next chunk, requested and not yet taken. A step that stops waiting leaves it here.
  reading?: Promise<IteratorResult<TurnStepChunk | Mark, TurnStepResult>>
}

// The plugin's tool, by its registered name, and the runs and calls in flight.
type Line = { id: string; send: Send; sent?: true }
export type Steps<Handed extends Line = Line> = {
  tool: string
  spawns: Map<string, string> // by an Agent tool_use id a step made: the harness subagent it shows
  jobs: Map<string, Job> // by agent id
  // By tool_use_id: the harness's own call id and input; question, when the call asks the person (the hook lets it through).
  calls: Map<string, { agentId: string; id: string; input?: CallInput; question?: true }>
  // By agent id: the harness's questions handed to the main agent, in the order they were handed (id: the harness's
  // question id). Only the first is sent to the main agent (sent, once it is), and only a sent one takes its answer;
  // the next is sent once it is answered or closed. Each goes once the harness closes it or the run ends: nothing then
  // waits on the answer.
  handed: Map<string, Handed[]>
}

// A handed question answered or closed: it leaves the line, and when it was the one the main agent had, the next
// goes to the main agent, after what the run has already said (a close already read goes first, and that message
// is then dropped). A reply the main agent wrote to a question closed after it was sent can still reach the next
// one: the main agent's message names no question.
export function dropHanded(w: Pick<Steps, 'handed'>, job: Job | undefined, agentId: string, id: string): void {
  const line = w.handed.get(agentId)
  const at = line?.findIndex((h) => h.id === id) ?? -1
  if (line === undefined || at < 0) return
  line.splice(at, 1)
  const [next] = line
  if (next === undefined) w.handed.delete(agentId)
  else if (at === 0) job?.held.push(next.send)
}

// The Agent calls a step makes for a harness's subagents: approved without the mode's classifier, which
// judges only a model's own calls, and their nested agents run as via's.
export const CHILD_CALL = 'toolu_via_child_'
// The calls a step makes for a harness's own tool calls and questions: ids no model request can carry.
export const STEP_CALL = 'toolu_step_'
// The SendMessage calls a step makes (a send mark).
export const SEND_CALL = 'toolu_via_send_'

// What a run ended early answers its next step: an aborted run's end of turn, as drive's own.
function ended(turnId: string): TurnStepResult {
  return { turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
}

// Aborted (Esc, a new turn) with the run parked at a yield: nothing would pull on to the race that stops it,
// so end it, which runs its cleanup and stops the harness. A wait would only return at once.
function halted(job: Job): boolean {
  if (!job.abort.signal.aborted) return false
  job.final ??= ended(job.turnId)
  void job.gen.return(undefined as never).catch(() => {})
  return true
}

// What a step says when the run's producer or its engine wait fails, and the run is ended.
const NOT_FOLLOWED = 'The harness run could not be followed: its producer or its wait failed.'

// The job's next chunk. Requested once and shared: a step that stops waiting leaves the same read for the
// next step or the tool call to take, so the generator advances once per chunk.
function read(job: Job): Promise<IteratorResult<TurnStepChunk | Mark, TurnStepResult>> {
  // A rejected read is not kept: the next read asks the generator, which has ended, and answers done.
  job.reading ??= job.gen.next().catch((error: unknown) => {
    job.reading = undefined
    throw error
  })
  return job.reading
}

// The engine's bounded wait for a run's next chunk: returns when the chunk arrives, when the bound passes,
// or at once if the run was replaced or aborted. It runs inside the engine, not the hook, because the hook's
// own budget is ten seconds and a silent harness can take longer than that. The read is shared, so a wait
// that returns early never advances the generator.
export async function waitStep(w: Steps, agentId: string, turnId: string, after: (wake: () => void) => Timer): Promise<void> {
  const job = w.jobs.get(agentId)
  if (job === undefined || job.turnId !== turnId || job.final !== undefined || job.abort.signal.aborted) return
  let timer: Timer | undefined
  try {
    await Promise.race([
      read(job).then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = after(resolve)
      }),
    ])
  } finally {
    timer?.cancel()
  }
}

// Stops a run no step will read again: a new turn, or the turn's end.
export function endJob(w: Steps, agentId: string): void {
  const job = w.jobs.get(agentId)
  if (job === undefined) return
  w.jobs.delete(agentId)
  w.handed.delete(agentId)
  for (const [id, call] of w.calls) if (call.agentId === agentId) w.calls.delete(id)
  job.abort.abort()
  void job.gen.return(undefined as never).catch(() => {})
}

// The reading hook's abort (Esc) stops the run.
function lend(job: Job, signal: AbortSignal): () => void {
  const forward = () => job.abort.abort()
  if (signal.aborted) forward()
  signal.addEventListener('abort', forward, { once: true })
  return () => signal.removeEventListener('abort', forward)
}

export async function* pump(
  w: Steps,
  job: Job,
  e: { turnId: string; index: number; agentId?: string },
  signal: AbortSignal,
  wait: () => Promise<void>,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const unlend = lend(job, signal)
  // Block indexes start again at each step.
  const blocks = new Map<number, number>()
  const block = (index: number) => {
    if (!blocks.has(index)) blocks.set(index, blocks.size)
    return blocks.get(index) as number
  }
  try {
    for (;;) {
      let c: TurnStepChunk | Mark
      const heldChunk = job.held.shift()
      if (heldChunk !== undefined) c = heldChunk
      else if (job.final !== undefined) {
        // A new turn may already hold this agent's slot.
        if (w.jobs.get(e.agentId ?? '') === job) {
          w.jobs.delete(e.agentId ?? '')
          w.handed.delete(e.agentId ?? '')
        }
        return { ...job.final, turnId: e.turnId, index: e.index }
      } else if (halted(job)) continue
      else {
        // Bounded: the hook answers within its budget. Without a chunk yet, wait again, and the read stays pending.
        // A failed read or wait ends the step with an explicit answer (below), never a hook error, which
        // would send the request to the model without the hooks.
        const arrived = await Promise.race([
          read(job).then(
            () => true,
            () => undefined,
          ),
          wait().then(
            () => false,
            () => undefined,
          ),
        ])
        if (arrived === undefined) {
          job.abort.abort()
          job.final ??= { ...ended(job.turnId), answer: NOT_FOLLOWED }
          void job.gen.return(undefined as never).catch(() => {})
          // After the abort: a caller that stops at this yield must not leave the run running.
          yield { kind: 'text', index: block(-2), text: NOT_FOLLOWED }
          continue
        }
        if (!arrived) continue
        const r = await read(job)
        job.reading = undefined
        if (r.done) {
          // A generator ended from outside returns nothing: without a final, this loop would spin.
          job.final = r.value ?? ended(e.turnId)
          continue
        }
        c = r.value
      }
      if (c.kind === 'call-end') {
        job.outputs.set(c.id, { output: c.output, failed: c.failed })
        continue
      }
      // Its question's hook has already answered; a question handed on no longer takes the answer.
      if (c.kind === 'question-closed') {
        dropHanded(w, job, e.agentId ?? '', c.id)
        continue
      }
      if (c.kind === 'send') {
        // A handed question closed or answered before its message went: the message no longer asks anything.
        const head = c.question === undefined ? undefined : w.handed.get(e.agentId ?? '')?.[0]
        if (c.question !== undefined && head?.id !== c.question) continue
        if (head !== undefined) head.sent = true
        job.count += 1
        const id = `${SEND_CALL}${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}_${job.count}`
        const input = { to: c.to, summary: c.summary, message: c.message }
        const index = block(-1 - job.count)
        yield { kind: 'tool', index, id, name: 'SendMessage' }
        yield { kind: 'input', index, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return {
          turnId: e.turnId,
          index: e.index,
          answer: '',
          toolUses: [{ name: 'SendMessage', input }],
          stopReason: 'tool_use',
          usage: null,
        }
      }
      if (c.kind === 'spawn') {
        job.count += 1
        const id = `${CHILD_CALL}${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}_${job.count}`
        w.spawns.set(id, c.child)
        const input = { description: c.title, prompt: c.prompt || c.title, subagent_type: c.type, run_in_background: true }
        const index = block(-1 - job.count)
        yield { kind: 'tool', index, id, name: 'Agent' }
        yield { kind: 'input', index, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Agent', input }], stopReason: 'tool_use', usage: null }
      }
      if (c.kind === 'call-start') {
        job.count += 1
        const id = `${STEP_CALL}${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}_${job.count}`
        w.calls.set(id, { agentId: e.agentId ?? '', id: c.id, input: c.input, ...(c.input.question ? { question: true as const } : {}) })
        const index = block(-1 - job.count)
        yield { kind: 'tool', index, id, name: w.tool }
        yield { kind: 'input', index, json: JSON.stringify(c.input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: c.usage }
        return {
          turnId: e.turnId,
          index: e.index,
          answer: '',
          toolUses: [{ name: w.tool, input: c.input }],
          stopReason: 'tool_use',
          usage: c.usage,
        }
      }
      yield 'index' in c ? { ...c, index: block(c.index) } : c
    }
  } finally {
    unlend()
  }
}

// While the person is asked a question: reads the run on until the harness closes that question (an interrupt,
// or it withdrew it) or the run ends, keeping whatever else it says for the next step. Stops reading when
// `stop` aborts (the person answered), leaving its read pending for the next step to take.
export async function questionClosed(w: Pick<Steps, 'jobs'>, ref: { agentId: string; id: string }, stop: AbortSignal): Promise<boolean> {
  const job = w.jobs.get(ref.agentId)
  if (job === undefined) return true
  const stopped = new Promise<'stopped'>((resolve) => {
    if (stop.aborted) resolve('stopped')
    stop.addEventListener('abort', () => resolve('stopped'), { once: true })
  })
  for (;;) {
    if (job.final !== undefined || halted(job)) return true
    const r = await Promise.race([read(job).catch(() => 'failed' as const), stopped])
    if (r === 'stopped') return false
    if (r === 'failed') {
      // The producer failed: end the run, as answerCall does.
      job.abort.abort()
      job.final ??= { ...ended(job.turnId), answer: NOT_FOLLOWED }
      return true
    }
    job.reading = undefined
    if (r.done) {
      job.final = r.value ?? ended(job.turnId)
      return true
    }
    if (r.value.kind === 'question-closed' && r.value.id === ref.id) return true
    if (r.value.kind === 'call-end') job.outputs.set(r.value.id, { output: r.value.output, failed: r.value.failed })
    else job.held.push(r.value)
  }
}

export const CALL_HOLD_MS = 15 * 60_000

// The tool.call hook on the plugin's tool: reads the run on until the harness finishes this call, keeping
// whatever else it says for the next step. Never runs anything itself.
export async function answerCall(
  w: Steps,
  toolUseId: string | undefined,
  signal: AbortSignal,
  wait: (agentId: string, turnId: string) => Promise<void>,
  now: () => number = Date.now,
): Promise<{ result: string; isError?: true } | { deny: string }> {
  const ref = toolUseId === undefined ? undefined : w.calls.get(toolUseId)
  const job = ref === undefined ? undefined : w.jobs.get(ref.agentId)
  if (ref === undefined || job === undefined)
    return { deny: 'This tool only reports a tool call an agent harness made; it does nothing when called.' }
  const unlend = lend(job, signal)
  const until = now() + CALL_HOLD_MS
  const input = ref.input ?? { kind: 'other', title: 'harness tool' }
  const waiting: Mark = {
    kind: 'call-start',
    id: ref.id,
    input: input.kind === 'wait' ? input : { kind: 'wait', title: `Waiting for ${input.title}` },
    usage: null,
  }
  try {
    for (;;) {
      const done = job.outputs.get(ref.id)
      if (done !== undefined) {
        w.calls.delete(toolUseId as string)
        return done.failed ? { result: done.output || 'failed', isError: true } : { result: done.output || NO_OUTPUT }
      }
      if (job.final !== undefined || halted(job)) return { result: 'The harness run ended before this call finished.' }
      // Bounded, as in pump: a harness command can run past the hook's ten-second budget, so the hook
      // waits through the engine's wait and reads only once a chunk has arrived. A failed read or wait
      // ends the run and answers the call, rather than fail the tool-call hook.
      if (now() >= until) {
        job.held.unshift(waiting)
        w.calls.delete(toolUseId as string)
        return { result: `The harness tool is still running after ${CALL_HOLD_MS / 60_000} minutes; waiting on in the next step.` }
      }
      const arrived = await Promise.race([
        read(job).then(
          () => true,
          () => undefined,
        ),
        wait(ref.agentId, job.turnId).then(
          () => false,
          () => undefined,
        ),
      ])
      if (arrived === undefined) {
        job.abort.abort()
        job.final ??= { ...ended(job.turnId), answer: NOT_FOLLOWED }
        void job.gen.return(undefined as never).catch(() => {})
        return { result: NOT_FOLLOWED }
      }
      if (!arrived) continue
      const r = await read(job)
      job.reading = undefined
      if (r.done) {
        // A generator ended from outside returns nothing: without a final, this loop would spin.
        job.final = r.value ?? ended(job.turnId)
        continue
      }
      if (r.value.kind === 'call-end') job.outputs.set(r.value.id, { output: r.value.output, failed: r.value.failed })
      else if (r.value.kind === 'spawn') {
        // Let the next step show the child now, while the harness's tool is still running. A native
        // Agent call preserves the child's hooks; spawning from this hook would skip it in the child.
        // The continuation only reads this same run and call id: it never executes the tool again.
        job.held.unshift(r.value, waiting)
        w.calls.delete(toolUseId as string)
        return { result: 'The harness tool is still running; showing its subagent now.' }
      } else job.held.push(r.value)
    }
  } finally {
    unlend()
  }
}
