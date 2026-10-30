export type Choice = {
  model?: string
  tools?: string
  thinking?: string
  tier?: 'fast' | 'default'
}
// A queued child's next event, through the engine so the hook's own-time budget is paused.
export type ViaChildren = {
  wait: (input: { key: string }) => Promise<void>
  // Starts reading a retained parent run's journal on the engine, once per run, and returns at once.
  follow: (input: {
    harness: string
    type: string
    parent: string
    argv: string[]
    receipt: { path: string; session?: string; scope?: string }
  }) => Promise<void>
}
export type ViaSteps = { wait: (input: { agentId: string }) => Promise<void> }
declare module 'claude-code' {
  interface EngineInterface {
    viaChildren: ViaChildren
    viaSteps: ViaSteps
  }

  interface PluginState {
    via: {
      agents: StateFamily<Choice>
      sessions: StateFamily<string>
      handbacks: StateFamily<boolean>
      reports: StateFamily<string>
      handedBack: StateFamily<boolean>
      modes: StateFamily<string>
      stepErrors: StateFamily<{
        kind: string
        message: string
        stack?: string
        stackOrigin: string
        turnId: string
        index: number
      }>
    }
  }
}
