import type { TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Mark } from '../hooks/acp/steps'
import { type Children, childRun, route } from '../hooks/children'

const world = (): Children => ({ channels: new Map(), nested: new Map() })

async function drain(gen: AsyncGenerator<TurnStepChunk | Mark, TurnStepResult>) {
  const out: (TurnStepChunk | Mark)[] = []
  for (;;) {
    const r = await gen.next()
    if (r.done) return { out, result: r.value }
    out.push(r.value)
  }
}

test('a child whose wait fails ends its answer with the failure, never by throwing', async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'List acp' })
  w.nested.set('n1', 'a1/c#1')
  const { result } = await drain(
    childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false, async () => {
      throw new Error('engine refused the wait')
    }),
  )
  expect(result.stopReason).toBe('end_turn')
  expect(result.answer).toContain('The codex subagent failed: could not wait for its next event')
})
