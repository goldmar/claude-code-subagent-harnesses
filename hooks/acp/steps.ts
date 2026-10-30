import type { Timer, TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'
import { NO_OUTPUT } from './render'

// One step per harness tool call. A run outlives the step that started it: each tool call the
// harness reports ends a step with a call to the plugin's own tool, whose tool.call hook (answerCall)
// reads the run on until the harness reports that call done, and the next step (pump) reads on
// from there. The tool runs nothing: a call to it nobody answers fails, where a Bash call whose hook
// failed would run the real command.

// A harness tool call starting or ending, for pump to make a call to the plugin's tool of; never reaches the engine.
// usage: the run's last model call, for the step that ends with the call.
export type Mark =
  | { kind: 'user'; text: string }
  | { kind: 'call-start'; id: string; input: { kind: string; title: string; path?: string }; usage: TurnUsage | null }
  | { kind: 'call-end'; id: string; output: string; failed: boolean }
  // A harness's subagent to show as an agent nested under this one: the step calls the Agent tool.
  | { kind: 'spawn'; child: string; type: string; title: string; description?: string }
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
  // A progress continuation reuses the outstanding read, never another generator.next().
  reading?: Promise<IteratorResult<TurnStepChunk | Mark, TurnStepResult>>
}

// The plugin's tool, by its registered name, and the runs and calls in flight.
export type Steps = {
  tool: string
  spawns: Map<string, string> // by an Agent tool_use id a step made: the harness subagent it shows
  jobs: Map<string, Job> // by agent id
  calls: Map<string, { agentId: string; id: string; input?: Extract<Mark, { kind: 'call-start' }>['input'] }> // by tool_use_id
  keepSpawn?: (id: string, key: string) => Promise<void>
}

function read(job: Job): Promise<IteratorResult<TurnStepChunk | Mark, TurnStepResult>> {
  job.reading ??= job.gen.next()
  return job.reading
}

async function take(job: Job): Promise<IteratorResult<TurnStepChunk | Mark, TurnStepResult>> {
  const result = await read(job)
  job.reading = undefined
  return result
}

// A continuation can inherit a read started by an earlier hook. Join it through an
// engine noun so this hook's own-time budget excludes the wait. Each noun reply stays
// below the engine's ten-second deadline, even when the command takes many minutes.
export async function waitStep(w: Steps, agentId: string, after: (wake: () => void) => Timer): Promise<void> {
  const job = w.jobs.get(agentId)
  if (!job || job.final !== undefined || job.abort.signal.aborted) return
  let timer: Timer | undefined
  try {
    await Promise.race([
      read(job),
      new Promise<void>((resolve) => {
        timer = after(resolve)
      }),
    ])
  } finally {
    timer?.cancel()
  }
}

// The Agent calls a step makes for a harness's subagents: approved without the mode's classifier, which
// judges only a model's own calls, and their nested agents run as via's.
export const CHILD_CALL = 'toolu_via_child_'

// What a run ended early answers its next step: an aborted run's end of turn, as drive's own.
function ended(turnId: string): TurnStepResult {
  return { turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
}

// Stops a run no step will read again: a new turn, or the turn's end.
export function endJob(w: Steps, agentId: string): void {
  const job = w.jobs.get(agentId)
  if (job === undefined) return
  w.jobs.delete(agentId)
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
  wait?: () => Promise<void>,
  user?: (text: string) => Promise<void>,
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
        w.jobs.delete(e.agentId ?? '')
        return { ...job.final, turnId: e.turnId, index: e.index }
      } else {
        const r = wait ? await Promise.race([read(job), wait().then(() => undefined)]) : await take(job)
        if (r === undefined) continue
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
      if (c.kind === 'user') {
        await user?.(c.text)
        continue
      }
      if (c.kind === 'spawn') {
        job.count += 1
        const id = `${CHILD_CALL}${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}_${job.count}`
        w.spawns.set(id, c.child)
        await w.keepSpawn?.(id, c.child)
        const input = { description: c.title, prompt: c.description || c.title, subagent_type: c.type, run_in_background: true }
        const index = block(-1 - job.count)
        yield { kind: 'tool', index, id, name: 'Agent' }
        yield { kind: 'input', index, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Agent', input }], stopReason: 'tool_use', usage: null }
      }
      if (c.kind === 'call-start') {
        job.count += 1
        const id = `toolu_step_${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}_${job.count}`
        w.calls.set(id, { agentId: e.agentId ?? '', id: c.id, input: c.input })
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

// The tool.call hook on the plugin's tool: reads the run on until the harness finishes this call, keeping
// whatever else it says for the next step. Never runs anything itself.
export async function answerCall(
  w: Steps,
  toolUseId: string | undefined,
  signal: AbortSignal,
  after?: (wake: () => void) => Timer,
  wait?: (agentId: string) => Promise<void>,
): Promise<{ result: string; isError?: true } | { deny: string }> {
  const ref = toolUseId === undefined ? undefined : w.calls.get(toolUseId)
  const job = ref === undefined ? undefined : w.jobs.get(ref.agentId)
  if (ref === undefined || job === undefined)
    return { deny: 'This tool only reports a tool call an agent harness made; it does nothing when called.' }
  const unlend = lend(job, signal)
  let timer: Timer | undefined
  const progress = new Promise<undefined>((resolve) => {
    timer = after?.(() => resolve(undefined))
  })
  try {
    for (;;) {
      const done = job.outputs.get(ref.id)
      if (done !== undefined) {
        w.calls.delete(toolUseId as string)
        return done.failed ? { result: done.output || 'failed', isError: true } : { result: done.output || NO_OUTPUT }
      }
      if (job.final !== undefined) return { result: 'The harness run ended before this call finished.' }
      // Aborted (Esc) with the run parked at a yield, which nothing would pull on to the race that stops it:
      // ending it runs its cleanup, which stops the harness.
      if (job.abort.signal.aborted) {
        job.final ??= ended(job.turnId)
        void job.gen.return(undefined as never).catch(() => {})
        return { result: 'The harness run ended before this call finished.' }
      }
      const r = await Promise.race([read(job), progress, ...(wait ? [wait(ref.agentId).then(() => 'wake' as const)] : [])])
      if (r === 'wake') continue
      if (r === undefined) {
        // Only the display advances. The command and its pending read continue under the same id.
        job.held.push({
          kind: 'call-start',
          id: ref.id,
          input: ref.input?.kind === 'wait' ? ref.input : { kind: 'wait', title: `Waiting for ${ref.input?.title ?? 'harness tool'}` },
          usage: null,
        })
        w.calls.delete(toolUseId as string)
        return { result: 'The harness tool is still running.' }
      }
      job.reading = undefined
      if (r.done) {
        job.final = r.value
        continue
      }
      if (r.value.kind === 'call-end') job.outputs.set(r.value.id, { output: r.value.output, failed: r.value.failed })
      else if (r.value.kind === 'spawn') {
        // Let the next step show the child now, while the harness's tool is still running. A native
        // Agent call preserves the child's hooks; spawning from this hook would skip it in the child.
        // The continuation only reads this same run and call id: it never executes the tool again.
        const input = ref.input ?? { kind: 'other', title: 'harness tool' }
        job.held.unshift(r.value, {
          kind: 'call-start',
          id: ref.id,
          input: input.kind === 'wait' ? input : { kind: 'wait', title: `Waiting for ${input.title}` },
          usage: null,
        })
        w.calls.delete(toolUseId as string)
        return { result: 'The harness tool is still running; showing its subagent now.' }
      } else job.held.push(r.value)
    }
  } finally {
    timer?.cancel()
    unlend()
  }
}
