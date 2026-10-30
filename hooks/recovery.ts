import type { EngineInterface } from 'claude-code'
import type { Choice } from '../types'
import type { Norm } from './acp/norm'
import type { Mark } from './acp/steps'
import type { Adapter, Mode } from './adapter'
import { closeChildren, route } from './children'
import type { RunResult } from './run'
import type { World } from './world'

// The roster is bounded, while output lives in private run directories instead of the store's 4 MiB.
const ROSTER = 'agents'
const ROSTER_KEPT = 200
export const ROSTER_UNAVAILABLE = 'via could not read its retained run mappings'
export type Receipt = {
  turnId: string
  path: string
  scope?: string
  choice: Choice
  mode: Mode
  session?: string
  compact?: boolean
  inbox?: string
  spawns?: Record<string, string>
}
export type Kept = { harness: string; handback: boolean; run?: Receipt; nested?: { key: string; parent: string; run?: Receipt } }
export async function roster($: Pick<EngineInterface, 'store'>): Promise<Record<string, Kept>> {
  const stored = await $.store.get(ROSTER).catch(() => {
    throw new Error(ROSTER_UNAVAILABLE)
  })
  if (typeof stored !== 'object' || stored === null) return {}
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, Kept] => typeof (entry[1] as Kept | null)?.harness === 'string',
    ),
  )
}
export function remember(w: World, $: Pick<EngineInterface, 'store'>, agentId: string, kept: Kept): Promise<void> {
  return updateRoster(w, $, agentId, (previous) => ({ ...previous, ...kept }))
}
function updateRoster(
  w: World,
  $: Pick<EngineInterface, 'store'>,
  agentId: string,
  update: (previous: Kept | undefined) => Kept | undefined,
): Promise<void> {
  const write = async () => {
    const stored = await roster($)
    const kept = update(stored[agentId])
    if (!kept) return
    const others = Object.entries(stored)
      .filter(([id]) => id !== agentId)
      .slice(-(ROSTER_KEPT - 1))
    await $.store.set(ROSTER, Object.fromEntries([...others, [agentId, kept]]))
  }
  // Each caller sees its own write's failure; a failed write must not cancel every later one.
  const written = (w.roster ?? Promise.resolve()).catch(() => undefined).then(write)
  w.roster = written
  return written
}
// Where each run keeps its journal and answer: <root>/<agent>/<turn>/<block>.
export async function runsRoot($: Pick<EngineInterface, 'env'>): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home}/.claude/via/runs` : undefined
}
// Finished runs past a week, then the oldest past 1 GiB in all, go; a running one never does.
export async function pruneRuns($: Pick<EngineInterface, 'env' | 'plugin' | 'process'>): Promise<void> {
  const root = await runsRoot($)
  if (root) await $.process.run(['node', helperOf($), 'prune', root], { timeoutMs: 30_000 })
}
export function helperOf($: Pick<EngineInterface, 'plugin'>): string {
  return `${$.plugin.root}/relay/src/durable.mts`
}
export async function answerOf($: Pick<EngineInterface, 'fs'>, path: string): Promise<RunResult | undefined> {
  try {
    const saved: unknown = JSON.parse(await $.fs.read(path))
    if (typeof saved !== 'object' || saved === null || typeof (saved as RunResult).signed !== 'string') return undefined
    return saved as RunResult
  } catch {
    return undefined
  }
}
export const answerPath = (receipt: Receipt, child?: string) =>
  `${receipt.path}/${child ? `children/${encodeURIComponent(child)}` : 'answer'}.json`

// The spawn id survives a process transition between a step's Agent call and agent.spawn.
export async function keepSpawn(w: World, $: Pick<EngineInterface, 'store'>, id: string, key: string): Promise<void> {
  const parent = key.slice(0, key.indexOf('/'))
  await updateRoster(w, $, parent, (kept) =>
    kept?.run ? { ...kept, run: { ...kept.run, spawns: { ...kept.run.spawns, [id]: key } } } : kept,
  )
}
export async function spawnOf($: Pick<EngineInterface, 'store'>, parent: string | undefined, id: string): Promise<string | undefined> {
  if (!parent) return undefined
  const stored = await roster($)
  const root = stored[parent]?.nested?.parent ?? parent
  return stored[root]?.run?.spawns?.[id]
}

export type Replay = {
  at: number
  pending: Mark[]
  waiters: Map<string, (found: boolean) => void>
  done?: Promise<void>
}
// One replay per retained run, shared by the parent and every resumed child reading its journal.
function replayOf(w: World, path: string): Replay {
  w.replays ??= new Map()
  let replay = w.replays.get(path)
  if (!replay) {
    replay = { at: 0, pending: [], waiters: new Map() }
    w.replays.set(path, replay)
  }
  return replay
}
// A waiter whose child's channel now exists learns so.
function settle(w: World, replay: Replay): void {
  for (const [key, resolve] of replay.waiters)
    if (w.channels.has(key)) {
      replay.waiters.delete(key)
      resolve(true)
    }
}
export function journalChildren(
  w: World,
  path: string,
  parent: string,
  type: string,
  at: number,
  event: Extract<Norm, { k: 'child' | 'of' }>,
): Replay {
  const replay = replayOf(w, path)
  // The parent and a resumed child may follow the same journal. Only the first reader of each
  // child event routes it; spawn marks remain for the parent's reader whichever follower won.
  if (at > replay.at) {
    replay.pending.push(...route(w, parent, type, event))
    replay.at = at
    settle(w, replay)
  }
  return replay
}
// A resumed nested view can read the parent's journal even if the parent has no next step. The
// follower never starts a harness; it only restores the channels this worker already produced.
type Follower = ReturnType<EngineInterface['process']['spawn']>
async function follow(
  w: World,
  start: () => Follower,
  type: string,
  adapter: Adapter,
  parent: string,
  receipt: Pick<Receipt, 'path' | 'session' | 'scope'>,
  replay: Replay,
) {
  let buffer = ''
  let at = 0
  const parse = adapter.events(receipt.session)
  let failure: string | undefined
  try {
    const stream = start()
    for await (const piece of stream) {
      if (piece.stream !== 'stdout') continue
      buffer += piece.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines)
        for (const event of parse(line))
          if (event.k === 'child' || event.k === 'of') journalChildren(w, receipt.path, receipt.scope ?? parent, type, ++at, event)
      settle(w, replay)
    }
    const exit = await stream.result
    if (exit.code !== 0) failure = 'the retained harness run ended before this child answered'
  } catch {
    failure = 'could not read the retained harness run'
  } finally {
    closeChildren(w, receipt.scope ?? parent, failure)
    for (const resolve of replay.waiters.values()) resolve(false)
    replay.waiters.clear()
  }
}
// Served as an engine noun: the follower runs on the engine's own interface, so no one child's stop
// ends it for its siblings. Once per retained run.
export function followRetained(
  w: World,
  start: () => Follower,
  type: string,
  adapter: Adapter,
  parent: string,
  receipt: Pick<Receipt, 'path' | 'session' | 'scope'>,
): void {
  const replay = replayOf(w, receipt.path)
  replay.done ??= follow(w, start, type, adapter, parent, receipt, replay)
}
// Waits for the journal to name this child, in bounded engine waits: the caller's own-time budget
// pauses through each, however long the parent's run takes to get there.
export async function attachChild(
  w: World,
  $: Pick<EngineInterface, 'viaChildren' | 'plugin'>,
  adapter: Adapter,
  key: string,
  parent: string,
  receipt: Receipt,
  signal?: AbortSignal,
) {
  if (w.channels.has(key)) return
  const replay = replayOf(w, receipt.path)
  await $.viaChildren.follow({
    harness: adapter.name,
    type: `${$.plugin.name}:${adapter.name}`,
    parent,
    argv: ['node', helperOf($), 'follow', receipt.path],
    receipt: {
      path: receipt.path,
      ...(receipt.session ? { session: receipt.session } : {}),
      ...(receipt.scope ? { scope: receipt.scope } : {}),
    },
  })
  const done = replay.done
  if (!done) return
  w.arrivals ??= new Map()
  let arrival = w.arrivals.get(key)
  if (!arrival) {
    arrival = Promise.race([new Promise<boolean>((resolve) => replay.waiters.set(key, resolve)), done.then(() => false)])
    w.arrivals.set(key, arrival)
    void arrival.then(() => w.arrivals?.delete(key))
  }
  let settled = false
  void arrival.then(() => {
    settled = true
  })
  while (!settled && !w.channels.has(key) && !signal?.aborted) await $.viaChildren.wait({ key })
}
