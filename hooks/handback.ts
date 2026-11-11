import type { EngineInterface, TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'

export const HANDBACK_TOOL = 'SubagentHandback'

export function textChunks(text: string): TurnStepChunk[] {
  return [
    { kind: 'text', index: 0, text },
    { kind: 'stop', stopReason: 'end_turn', usage: null },
  ]
}

export async function* respond(
  e: { turnId: string; index: number },
  chunks: TurnStepChunk[],
  answer: string,
  toolUses: TurnStepResult['toolUses'] = [],
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield* chunks
  const stop = chunks.at(-1)
  return {
    turnId: e.turnId,
    index: e.index,
    answer,
    toolUses,
    stopReason: stop?.kind === 'stop' ? stop.stopReason : 'end_turn',
    usage: stop?.kind === 'stop' ? stop.usage : null,
  }
}

export async function handbackAsked($: Pick<EngineInterface, 'session'>, agentId: string): Promise<boolean> {
  const rows = await $.session.messages({ agentId })
  return Array.isArray(rows) && rows.some((m) => m.role === 'user' && m.text.includes(HANDBACK_TOOL))
}

// The answer as a SubagentHandback call, which auto mode asks a local agent to end with.
export async function* deliver(
  name: string,
  e: { turnId: string; index: number },
  block: number,
  report: string,
  usage: TurnUsage | null,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const input = { message: report }
  const id = `toolu_${name}_${e.turnId.replace(/[^A-Za-z0-9_]/g, '_')}`
  return yield* respond(
    e,
    [
      { kind: 'tool', index: block, id, name: HANDBACK_TOOL },
      { kind: 'input', index: block, json: JSON.stringify(input) },
      { kind: 'stop', stopReason: 'tool_use', usage },
    ],
    report,
    [{ name: HANDBACK_TOOL, input }],
  )
}
