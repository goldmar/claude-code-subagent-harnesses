export type Choice = {
  model?: string
  tools?: string
  thinking?: string
  tier?: 'fast' | 'default'
}
// A queued child's next event, through the engine so the hook's own-time budget is paused.
export type ViaChildren = { wait: (input: { key: string }) => Promise<void> }
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
    }
  }
}
