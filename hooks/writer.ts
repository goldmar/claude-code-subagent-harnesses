import type { TurnStepChunk, TurnUsage } from 'claude-code'
import type { Mark } from './acp/steps'

// What a run says, block by block, and its answer so far: one for a via agent's run (run.ts), one for a
// nested agent's (children.ts). Each call, plan row or spawn ends a step, and Claude Code takes the last
// step's text as the answer: `spoke` says whether the answer is in the step being written.
export class StepWriter {
  index: number
  report = ''
  spoke = false
  private kind: 'text' | 'thinking' | undefined
  private listed = '' // the plan last shown
  private plans = 0

  constructor(first = 0) {
    this.index = first - 1
  }

  private push(kind: 'text' | 'thinking', text: string): TurnStepChunk {
    if (kind !== this.kind) {
      this.kind = kind
      this.index += 1
    }
    return { kind, index: this.index, text }
  }

  // Part of the answer.
  text(t: string): TurnStepChunk {
    this.report += t
    this.spoke = true
    return this.push('text', t)
  }

  // Shown, not part of the answer: a tool line, a notice, the signature.
  say(t: string): TurnStepChunk {
    return this.push('text', t)
  }

  thinking(t: string): TurnStepChunk {
    return this.push('thinking', t)
  }

  // Input copied into a nested transcript. A late acknowledgement must leave the answer intact.
  user(text: string, preserveAnswer = false): Mark {
    if (!preserveAnswer) this.message()
    else this.kind = undefined
    return { kind: 'user', text }
  }

  // A new message: only the last one is the answer, and it starts a block of its own.
  message(): void {
    this.report = ''
    this.boundary()
  }

  // A chunk that ends a step: what follows starts a new block, in a step the answer is not yet in.
  boundary(): void {
    this.kind = undefined
    this.spoke = false
  }

  call(id: string, input: { kind: string; title: string; path?: string }, usage: TurnUsage | null): Mark {
    this.boundary()
    return { kind: 'call-start', id, input, usage }
  }

  // A row of its own, opened and closed at once, as Claude Code's own to-do list is: only on a change.
  plan(entries: readonly { content: string; status: string }[], usage: TurnUsage | null): Mark[] {
    const listed = entries.map((entry) => `${PLAN_MARKS[entry.status] ?? '☐'} ${entry.content}`).join('\n')
    if (listed === this.listed) return []
    this.listed = listed
    this.plans += 1
    const id = `plan-${this.plans}`
    return [this.call(id, { kind: 'plan', title: 'Plan' }, usage), { kind: 'call-end', id, output: listed, failed: false }]
  }
}

const PLAN_MARKS: Record<string, string> = { pending: '☐', in_progress: '◐', completed: '☑' }

// The line that ends a genuine answer.
export const answeredBy = (who: string, by?: string) => `— answered by ${who}${by ? `, ${by}` : ''}`
