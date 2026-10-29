import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { hold, NODE, run, STEP, storage } from './helpers'

declare function setTimeout(fn: () => void, ms: number): number

declare module 'claude-code' {
  interface EngineInterface {
    testTime: { wait: (input: { ms: number }) => Promise<void> }
  }
}

const REAL_CLOCK = {
  name: 'real-clock',
  register: ((on) => {
    let starts = 0
    const update = (sessionId: string, update: unknown) => ({ sessionId, update })
    const text = (value: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
    const line = (events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    on('process.spawn', async function* ($, e) {
      const seconds = e.input?.includes('go300') ? 300 : 45
      const helper = seconds === 45
      await $.fs.write('/test/runtime-starts', String(++starts))
      yield {
        stream: 'stdout',
        text: line([
          { relay: 'session', sessionId: 'root' },
          { relay: 'steered' },
          ...(helper
            ? [
                update('root', {
                  sessionUpdate: 'subagent_update',
                  sessionId: 'helper',
                  title: 'sleep 20; date -u; echo NESTED_OK',
                  state: { state: 'running' },
                }),
              ]
            : []),
          ...(helper
            ? [
                update('root', {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'initial',
                  kind: 'execute',
                  title: 'date -u; echo PARENT_OK',
                  status: 'in_progress',
                }),
                update('root', {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'initial',
                  status: 'completed',
                  _meta: { terminal_output_delta: { data: 'PARENT_OK' } },
                }),
              ]
            : []),
          update('root', {
            sessionUpdate: 'tool_call',
            toolCallId: 'long',
            kind: 'execute',
            title: `sleep ${seconds}; date -u`,
            status: 'in_progress',
          }),
        ]),
      }
      for (let i = 0; i < (helper ? 20 : seconds); i += 1) {
        await $.testTime.wait({ ms: 1_000 })
      }
      yield {
        stream: 'stdout',
        text: line([
          ...(helper
            ? [
                update('helper', text('NESTED_OK')),
                update('root', { sessionUpdate: 'subagent_update', sessionId: 'helper', state: { state: 'idle' } }),
              ]
            : []),
        ]),
      }
      for (let i = 0; i < (helper ? 25 : 0); i += 1) {
        await $.testTime.wait({ ms: 1_000 })
      }
      yield {
        stream: 'stdout',
        text: line([
          update('root', {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'long',
            status: 'completed',
            _meta: { terminal_output_delta: { data: 'PARENT_DONE' } },
          }),
          update('root', text('both finished')),
        ]),
      }
      return { value: { code: 0, signal: null } }
    })
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      testTime: { wait: ({ ms }: { ms: number }) => new Promise<void>((resolve) => setTimeout(resolve, ms)) },
    }))
    on('clock.after', async ($, e, next) => {
      try {
        for (let remaining = e.ms; remaining > 0; remaining -= 1_000) await $.testTime.wait({ ms: Math.min(remaining, 1_000) })
      } catch (error) {
        if (!next.signal.aborted) throw error
      }
      return { value: undefined }
    })
  }) satisfies Register,
}

for (const minutes of [5, 11])
  test(`a single silent parent command yields progress for ${minutes} virtual minutes without helpers or replay`, async ($, on) => {
    const clock = mock.clock(on)
    const spawns: Parameters<typeof hold>[1] = []
    const before = [{ type: 'tool_execution_start', toolCallId: 'long', toolName: 'bash', args: { command: `sleep ${minutes * 60}` } }]
    const after = [
      { type: 'tool_execution_end', toolCallId: 'long', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'finished' } },
    ]
    const held = hold(on, spawns, [], before, after)
    await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
    let step = await run($)
    for (let index = 0; index < minutes * 2; index += 1) {
      const tool = step.chunks.find((chunk) => chunk.kind === 'tool')
      expect(tool?.kind).toBe('tool')
      let answered = false
      const pending = $.tool
        .call({ tool: 'mcp__plugin_via_step__step', tool_use_id: tool?.kind === 'tool' ? tool.id : '' } as never)
        .then((result) => {
          answered = true
          return result
        })
      await clock.settle()
      await clock.advance(30_000)
      expect(answered).toBe(true)
      await pending
      step = await run($, { ...STEP, index: index + 1 })
      expect(step.result.stopReason).toBe('tool_use')
      expect(spawns).toHaveLength(1)
    }
    held.release()
    const tool = step.chunks.find((chunk) => chunk.kind === 'tool')
    await $.tool.call({ tool: 'mcp__plugin_via_step__step', tool_use_id: tool?.kind === 'tool' ? tool.id : '' } as never)
    expect((await run($, { ...STEP, index: minutes * 2 + 1 })).result.answer).toContain('finished')
    expect(spawns).toHaveLength(1)
  })

// Keep real elapsed time here: advancing only the mock clock cannot expose the engine's
// ten-second own-time budget on the second reader of the same generator.next().
for (const seconds of [45, 300])
  test(
    `a ${seconds}-second parent command survives real hook budgets (${seconds === 45 ? 'one native helper' : 'no helpers'})`,
    { timeoutMs: (seconds + 20) * 1_000, plugins: [REAL_CLOCK] },
    async ($, on) => {
      const helper = seconds === 45
      const files = storage(on)
      mock.env(on, { HOME: '/home/u' })
      on('agent.list', () => ({ value: [{ id: 'a1', description: 'parent', type: 'via:codex', status: 'running' }] }))
      on('session.messages', () => ({ value: [] }))
      on('turn.start', (_, e) => ({ turnId: e.turnId }))
      on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
      on('fs.write', (_, e) => {
        files.set(e.path, e.text)
        return { value: undefined }
      })
      on('process.run', () => ({ value: NODE }))
      on('agent.spawn', () => ({ agentId: 'n1', model: 'codex' }))
      const began = Date.now()
      await $.turn.start({ turnId: 't1', agentId: 'a1', text: `go${seconds}` })
      let index = 0
      let step = await run($)
      if (helper) {
        const agentTool = step.chunks.find((chunk) => chunk.kind === 'tool')
        expect(agentTool?.kind === 'tool' && agentTool.name).toBe('Agent')
        await $.agent.spawn({
          tool_use_id: agentTool?.kind === 'tool' ? agentTool.id : '',
          subagentType: 'via:codex',
          prompt: 'helper',
          description: 'helper',
          provider: { plugin: 'engine', tier: 'core' },
          parentModel: 'codex',
          parentAgentId: 'a1',
          background: true,
          fork: false,
        })
        step = await run($, { ...STEP, index: ++index })
      }
      const call = async (step: Awaited<ReturnType<typeof run>>) => {
        const tool = step.chunks.find((chunk) => chunk.kind === 'tool')
        return $.tool.call({ tool: 'mcp__plugin_via_step__step', tool_use_id: tool?.kind === 'tool' ? tool.id : '' } as never)
      }
      if (helper) {
        expect(await call(step)).toEqual({ result: 'PARENT_OK' })
        step = await run($, { ...STEP, index: ++index })
      }
      let continuations = 0
      for (;;) {
        const result = await call(step)
        if ('result' in result && result.result === 'PARENT_DONE') break
        expect(result).toEqual({ result: 'The harness tool is still running.' })
        continuations += 1
        step = await run($, { ...STEP, index: ++index })
      }
      expect(continuations).toBeGreaterThanOrEqual(Math.floor((seconds - 1) / 30))
      expect(Date.now() - began).toBeGreaterThanOrEqual(seconds * 1_000)
      expect((await run($, { ...STEP, index: ++index })).result.answer).toContain('both finished')
      if (helper) expect((await run($, { ...STEP, agentId: 'n1', turnId: 'child' })).result.answer).toContain('NESTED_OK')
      expect(files.get('/test/runtime-starts')).toBe('1')
    },
  )
