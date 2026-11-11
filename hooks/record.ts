import type { EngineInterface } from 'claude-code'
import type { Choice } from '../types'

// Everything via knows about one of its agents, in one place. Kept in $.store, the one tier that outlives
// the process: a session sent to the background continues in a new process with none of the spawn's
// memory, and $.state only survives a reload of the plugin's code.
export type AgentRecord = {
  harness: string
  nested?: true // a harness's own subagent: only its parent's run can answer it
  handback: boolean // spawned locally in auto mode: its answer goes back as a SubagentHandback
  mode: string // Claude Code's permission mode at the spawn
  description?: string // the spawn's Agent description, for its panel row
  choice?: Choice // the model, tools, thinking and Codex tier its prompts asked for
  session?: string // the harness's session, which its next turn resumes
  report?: string // its last answer
  handedBack?: boolean // that answer has gone back
  // Made up in this process for an agent with no record it could read (spawned before via loaded, evicted, or
  // a store that failed): never stored, so it cannot overwrite the real one.
  rebuilt?: true
}

export type Records = {
  records: Map<string, AgentRecord>
  writing?: Promise<void> // one write at a time, or two spawns at once drop each other from the index
  unsaved?: true // a store failure was logged: once per process
  cleared?: true // 0.8's roster, under 'agents', is gone
}

// The store holds 4 MiB of JSON in all, shared with the model lists: KEPT agents with answers of at most
// REPORT_KEPT characters stay well under it (about 2.3 MiB at worst, all of it CJK), so it cannot fill and stop saving.
const INDEX = 'agent-ids'
const KEPT = 50
const REPORT_KEPT = 16_000
const keyOf = (agentId: string) => `agent:${agentId}`
type Store = Pick<EngineInterface, 'store' | 'ui'>

const isRecord = (value: unknown): value is AgentRecord =>
  typeof value === 'object' && value !== null && typeof (value as AgentRecord).harness === 'string'

// Said once: an agent resumed after a restart then has no record, and runs read-only without its answer.
function unsaved(w: Records, $: Store, error: unknown): void {
  if (w.unsaved) return
  w.unsaved = true
  try {
    let why = 'unknown error'
    try {
      why = String(error)
    } catch {}
    $.ui.log(
      `via could not read or save its agent records (${why}): an agent resumed after a restart runs read-only, without its last answer.`,
    )
  } catch {}
}

// From memory, or from the store for an agent another process spawned.
export async function recordOf(w: Records, $: Store, agentId: string): Promise<AgentRecord | undefined> {
  const held = w.records.get(agentId)
  if (held !== undefined) return held
  const stored = await $.store.get(keyOf(agentId)).catch((error: unknown) => unsaved(w, $, error))
  if (!isRecord(stored)) return undefined
  // A spawn that landed while the store answered wins: it is newer.
  const raced = w.records.get(agentId)
  if (raced !== undefined) return raced
  w.records.set(agentId, stored)
  return stored
}

function persist(w: Records, $: Store, write: () => Promise<void>): Promise<void> {
  w.writing = (w.writing ?? Promise.resolve()).then(write).catch((error: unknown) => unsaved(w, $, error))
  return w.writing
}

// As stored: a long answer keeps its end, where the signature and any failure are.
function stored(record: AgentRecord): AgentRecord {
  const report = record.report
  if (report === undefined || report.length <= REPORT_KEPT) return { ...record }
  return { ...record, report: `[earlier part cut; the whole answer is in the transcript]\n…${report.slice(-REPORT_KEPT)}` }
}

// A new agent: in memory at once, so a first step that runs before the store answers still sees it. The
// newest KEPT stay in the store. A failed index read aborts the write rather than lose the index.
export function createRecord(w: Records, $: Store, agentId: string, record: AgentRecord): Promise<void> {
  w.records.set(agentId, record)
  return persist(w, $, async () => {
    if (!w.cleared) {
      w.cleared = true
      await $.store.delete('agents').catch(() => undefined)
    }
    const listed = await $.store.get(INDEX)
    const ids = [...(Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string' && id !== agentId) : []), agentId]
    for (const old of ids.splice(0, Math.max(0, ids.length - KEPT))) await $.store.delete(keyOf(old)).catch(() => undefined)
    await $.store.set(keyOf(agentId), stored(record))
    await $.store.set(INDEX, ids)
  })
}

// A change to a known agent: in memory at once, then stored. An agent with no record has nothing to change.
export function updateRecord(w: Records, $: Store, agentId: string, change: Partial<AgentRecord>): Promise<void> {
  const held = w.records.get(agentId)
  if (held === undefined) return Promise.resolve()
  Object.assign(held, change)
  if (held.rebuilt) return Promise.resolve()
  const snapshot = stored(held)
  return persist(w, $, () => $.store.set(keyOf(agentId), snapshot))
}
