import { expect, test } from 'claude-code/testing'
import { createRecord, type Records, recordOf, updateRecord } from '../hooks/record'

// The two nouns a record touches; the rest of the engine is never reached.
type Engine = Parameters<typeof createRecord>[1]

function memory() {
  const held = new Map<string, unknown>()
  const logged: string[] = []
  const $ = {
    store: {
      get: async (key: string) => held.get(key),
      set: async (key: string, value: unknown) => {
        held.set(key, value)
      },
      delete: async (key: string) => {
        held.delete(key)
      },
      keys: async () => [...held.keys()],
    },
    ui: { log: (text: string) => logged.push(text) },
  }
  return { held, $: $ as unknown as Engine, logged }
}

test('the store keeps the newest 50 agents, oldest dropped first', async () => {
  const { held, $ } = memory()
  const w: Records = { records: new Map() }
  for (let i = 0; i < 51; i += 1) void createRecord(w, $, `a${i}`, { harness: 'pi', handback: false, mode: 'default' })
  await w.writing
  const ids = held.get('agent-ids') as string[]
  expect(ids).toHaveLength(50)
  expect(ids[0]).toBe('a1')
  expect(held.has('agent:a0')).toBe(false)
  expect(held.has('agent:a50')).toBe(true)
})

test('a new process reads the record another process wrote, with its latest changes', async () => {
  const { $ } = memory()
  const old: Records = { records: new Map() }
  await createRecord(old, $, 'a1', { harness: 'codex', handback: true, mode: 'auto' })
  await updateRecord(old, $, 'a1', { report: 'done', handedBack: true })
  const fresh: Records = { records: new Map() }
  expect(await recordOf(fresh, $, 'a1')).toEqual({ harness: 'codex', handback: true, mode: 'auto', report: 'done', handedBack: true })
})

test('a store that refuses leaves the record in memory, and the step goes on', async () => {
  const $ = {
    store: {
      get: async () => {
        throw new Error('no store')
      },
      set: async () => {
        throw new Error('no store')
      },
      delete: async () => undefined,
      keys: async () => [],
    },
    ui: { log: (text: string) => logged.push(text) },
  } as unknown as Engine
  const logged: string[] = []
  const w: Records = { records: new Map() }
  await createRecord(w, $, 'a1', { harness: 'pi', handback: false, mode: 'default' })
  expect(await recordOf(w, $, 'a1')).toMatchObject({ harness: 'pi' })
  expect(await recordOf(w, $, 'a2')).toBeUndefined()
  // Said once, however many reads and writes fail.
  expect(logged).toHaveLength(1)
  expect(logged[0]).toContain('runs read-only, without its last answer')
})

test('a long answer is stored by its end, so the store cannot fill; memory keeps it whole', async () => {
  const { held, $ } = memory()
  const w: Records = { records: new Map() }
  await createRecord(w, $, 'a1', { harness: 'pi', handback: false, mode: 'default' })
  const answer = `${'x'.repeat(100_000)}\n\n— answered by pi, kimi`
  await updateRecord(w, $, 'a1', { report: answer })
  const saved = (held.get('agent:a1') as { report: string }).report
  expect(saved.length).toBeLessThan(17_000)
  expect(saved.endsWith('— answered by pi, kimi')).toBe(true)
  expect(w.records.get('a1')?.report).toBe(answer)
})

test("0.8's roster is removed from the store", async () => {
  const { held, $ } = memory()
  held.set('agents', { a0: { harness: 'pi', handback: false } })
  const w: Records = { records: new Map() }
  await createRecord(w, $, 'a1', { harness: 'pi', handback: false, mode: 'default' })
  expect(held.has('agents')).toBe(false)
})
