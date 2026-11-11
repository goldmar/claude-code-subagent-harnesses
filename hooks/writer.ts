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
    if (!preserveAnswer) {
      this.message()
      this.boundary()
    } else this.kind = undefined
    return { kind: 'user', text }
  }

  // A new message: only the last one is the answer.
  message(): void {
    this.report = ''
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
}

// The line that ends a genuine answer.
export const answeredBy = (who: string, by?: string) => `— answered by ${who}${by ? `, ${by}` : ''}`
