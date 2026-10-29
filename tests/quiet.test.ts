import { expect, mock, test } from 'claude-code/testing'
import { hold, run, STEP } from './helpers'

test('a silent command yields bounded progress for eleven minutes without executing twice', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Parameters<typeof hold>[1] = []
  const before = [{ type: 'tool_execution_start', toolCallId: 'long', toolName: 'bash', args: { command: 'sleep 660' } }]
  const after = [
    { type: 'tool_execution_end', toolCallId: 'long', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'finished' } },
  ]
  const held = hold(on, spawns, [], before, after)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  let step = await run($)
  for (let index = 0; index < 22; index += 1) {
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
  expect((await run($, { ...STEP, index: 23 })).result.answer).toContain('finished')
  expect(spawns).toHaveLength(1)
})
