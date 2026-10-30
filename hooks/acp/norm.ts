// What a harness run says, normalized: every adapter's parser yields these, and the core reads them.
export type Usage = {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

export type Norm =
  | { readonly k: 'message' } // a new assistant message starts: only the last one is the answer
  | { readonly k: 'user'; readonly t: string } // a complete parent-to-child message, displayed as user input
  | { readonly k: 'session'; readonly id: string } // harness-issued id, saved at once for follow-ups
  | { readonly k: 'model'; readonly name: string }
  | { readonly k: 'text' | 'thinking' | 'tool'; readonly t: string }
  // A harness tool call that starts, then ends: each becomes a call to the plugin's own tool in Claude Code's
  // transcript, its row drawn by the plugin. A harness that reports only `tool` keeps a text line instead.
  // path: the file the call acts on, when the agent names one (its row links to it).
  | { readonly k: 'call'; readonly id: string; readonly kind: string; readonly title: string; readonly path?: string }
  | { readonly k: 'called'; readonly id: string; readonly output: string; readonly failed: boolean }
  // The agent's plan, whole, each time it changes.
  | { readonly k: 'plan'; readonly entries: readonly { readonly content: string; readonly status: string }[] }
  | { readonly k: 'usage'; readonly usage: Usage } // the core keeps the last one: per message, never a running total
  | { readonly k: 'steered' }
  | { readonly k: 'error'; readonly message: string }
  | { readonly k: 'notice'; readonly t: string } // said after the answer, as part of it
  | { readonly k: 'interrupted' } // the harness took an interrupt itself: nothing for the core to rerun
  | { readonly k: 'ask'; readonly ask: Ask } // a permission question for the person; the core writes the answer to the inbox
  // A subagent the harness started (ACP's subagent_update), announced or updated: parent is the session that
  // owns it, state its current work (idle: done for now), failure why its work ended, when it failed.
  | {
      readonly k: 'child'
      readonly id: string
      readonly parent: string
      readonly title?: string
      readonly description?: string
      readonly state?: string
      readonly failure?: string
    }
  | { readonly k: 'of'; readonly child: string; readonly norm: Norm } // what a subagent's own session said

export type Ask = {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly command?: string
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[]
}

// Claude Code's permission mode, as the spawn carried it: what the person allows Claude itself.
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'
