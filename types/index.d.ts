export type Choice = {
  model?: string
  tools?: string
  thinking?: string
  tier?: 'fast' | 'default'
}
declare module 'claude-code' {
  interface EngineInterface {
    viaSteps: { wait: (input: { agentId: string; turnId: string }) => Promise<void> }
    viaChildren: { wait: (input: { key: string }) => Promise<void> }
  }
}
