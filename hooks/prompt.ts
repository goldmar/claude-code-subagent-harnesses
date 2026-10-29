import type { HelpAdapter, PromptAdapter } from './adapter'

// A model never starts with '-': passed as its own argument, it would read as a flag. A pi tool list may
// (-bash,read removes bash), since it always follows --tools.
const VALUE = { model: /^[A-Za-z0-9_.:/*~@+][A-Za-z0-9_.:/*~@+-]*$/, tools: /^[A-Za-z0-9_*+,:.-]+$/, thinking: /^\S+$/, tier: /^\S+$/ }
type PromptKey = keyof typeof VALUE
const NEUTRAL_LINE = /^(model|tools|thinking|tier):[ \t]*(.*?)[ \t]*$/
const ALIAS_LINE = /^([A-Za-z]+)-([A-Za-z]+):[ \t]*(.*?)[ \t]*$/
const HELP_LINE = /^([A-Za-z]+)-help[ \t]*$/i

export type PromptSpec = {
  prompt: string
  model?: string
  tools?: string
  thinking?: string
  tier?: 'fast' | 'default'
  help?: boolean
  error?: string
}

export const isModel = (value: string) => VALUE.model.test(value)

// pi and OpenCode list hundreds: the help names the first, and the harness's own command finds the rest.
const LISTED = 30

function helpName(line: string, adapter: PromptAdapter): boolean {
  const name = HELP_LINE.exec(line)?.[1]?.toLowerCase()
  return name === 'via' || name === adapter.name.toLowerCase()
}

function isHeader(line: string, adapter: PromptAdapter): boolean {
  if (helpName(line, adapter)) return true
  if (NEUTRAL_LINE.test(line)) return true
  return ALIAS_LINE.exec(line)?.[1] === adapter.name
}

export function promptOf(text: string, adapter: PromptAdapter): PromptSpec {
  const lines = text.trimStart().split('\n')
  let end = 0
  while (end < lines.length && isHeader(lines[end] ?? '', adapter)) end += 1
  if (end === 0) return { prompt: text }

  const asked: Omit<PromptSpec, 'prompt' | 'error' | 'help'> = {}
  let help = false
  for (const line of lines.slice(0, end)) {
    if (helpName(line, adapter)) {
      help = true
      continue
    }
    const neutral = NEUTRAL_LINE.exec(line)
    const alias = ALIAS_LINE.exec(line)
    const key = (neutral?.[1] ?? alias?.[2] ?? '').toLowerCase()
    const value = neutral?.[2] ?? alias?.[3] ?? ''
    const label = neutral ? key : `${adapter.name}-${key}`
    const bad = (why: string) => ({ prompt: text, error: `Invalid ${adapter.name} prompt line ${JSON.stringify(line)}: ${why}` })
    if (!(key in VALUE))
      return bad(
        `unknown key; known keys are model, tools and thinking (or ${adapter.name}-model, ${adapter.name}-tools and ${adapter.name}-thinking)${adapter.name === 'codex' ? ', plus tier (or codex-tier)' : ''}.`,
      )
    if (!VALUE[key as PromptKey].test(value)) return bad('expected one whitespace-free value.')
    if (key === 'tier') {
      if (adapter.name !== 'codex') return bad(`${label} is not supported: tier is codex only.`)
      if (value !== 'fast' && value !== 'default') return bad(`${label} must be one of fast, default; got ${JSON.stringify(value)}.`)
      asked.tier ??= value
    } else if (key === 'thinking') {
      if (adapter.thinking.length === 0) return bad(`${label} is not supported: ${adapter.name} takes no thinking level.`)
      if (!adapter.thinking.includes(value))
        return bad(`${label} must be one of ${adapter.thinking.join(', ')}; got ${JSON.stringify(value)}.`)
      asked.thinking ??= value
    } else if (key === 'tools') {
      if (adapter.readOnly === 'none') return bad(`${adapter.name} cannot enforce read-only tools, so a tools line is refused.`)
      if (adapter.tools && !adapter.tools.includes(value))
        return bad(`${label} must be one of ${adapter.tools.join(', ')}; got ${JSON.stringify(value)}.`)
      asked.tools ??= value
    } else {
      asked.model ??= value
    }
  }
  const prompt = lines.slice(end).join('\n').trim()
  return help ? { prompt, help } : { prompt, ...asked }
}

// models: the harness's own list, best or default first; empty until via has read it once.
export function helpOf(adapter: HelpAdapter, models: readonly string[]): string {
  const name = adapter.name
  const shown = models.slice(0, LISTED)
  const more = models.length > shown.length ? ` and ${models.length - shown.length} more` : ''
  const offered = shown.length > 0 ? ` ${name} offers ${shown.join(', ')}${more}.` : ''
  const lines = [
    `${name} prompt lines: put them at the top of the prompt, one per line, before the task. Each holds for this agent's later messages until a new line replaces it.`,
    `model: <pattern>    passed to ${adapter.bin} as its model.${offered}${adapter.models ? ` ${adapter.models}` : ''}`,
  ]
  if (adapter.readOnly === 'none') lines.push(`tools:              refused: ${name} cannot enforce read-only tools.`)
  else if (adapter.tools)
    lines.push(`tools: read|write   read: ${name} runs read-only and cannot edit files. write, or no tools line: it can.`)
  else
    lines.push(
      `tools: <list>       passed to ${name} as its tool list: read is read-only; any other list, such as -bash,read, can still edit and loads the project's .pi extensions.`,
    )
  if (adapter.thinking.length > 0)
    lines.push(`thinking: <level>   passed to ${name} as its thinking level: ${adapter.thinking.join(', ')}.`)
  else lines.push(`thinking:           refused: ${name} takes no thinking level.`)
  if (name === 'codex') lines.push('tier: fast|default  fast mode on or off; change it in an idle follow-up, not a running message.')
  lines.push(
    adapter.defaultModel
      ? `Model precedence: a model line, then the plugin's defaultModel setting, then ${name}'s own default.`
      : `Model precedence: a model line, then ${name}'s own default.`,
  )
  lines.push(
    adapter.steer
      ? 'A message to a running agent reaches it at its next step; a message to an idle agent is a follow-up.'
      : 'Messages to an agent are follow-ups: this harness takes no mid-run steering.',
  )
  if (adapter.steer) lines.push('A message starting interrupt: stops the current step and runs at once.')
  if (name === 'codex')
    lines.push(
      'Codex may report "aborted before dispatch" while admitting a native helper mailbox message. Inspect that message and current state before deciding whether the operation still needs to run; via does not retry it automatically.',
    )
  lines.push(`A genuine answer ends with — answered by ${name}, <model>. Example:`)
  if (models[0]) lines.push(`model: ${models[0]}`)
  if (adapter.thinking.includes('high')) lines.push('thinking: high')
  lines.push('Review the error handling in src/api.')
  return lines.join('\n')
}

export function descriptionOf(adapter: HelpAdapter, models: readonly string[]): string {
  const top = models[0] ? [`\`model: ${models[0]}\``] : []
  if (adapter.readOnly !== 'none') top.push('`tools: read`')
  if (adapter.thinking.length > 0) top.push('`thinking: high`')
  const steer = adapter.steer ? ' SendMessage steers it mid-run; one starting `interrupt:` stops its current step first.' : ''
  return `${adapter.about} Top lines: ${top.join(' ')}. \`via-help\` for more.${steer}`
}

// The offered models closest to one a harness refused, by shared name parts (deepseek, v4, free).
// The provider, before the first slash, never counts alone: every one of its models shares it.
export function nearestModels(asked: string, models: readonly string[], count = 3): string[] {
  const parts = (id: string) =>
    new Set(
      id
        .toLowerCase()
        .split(/[/\-_.:~@+\s]+/)
        .filter(Boolean),
    )
  const provider = (id: string) => (id.includes('/') ? id.slice(0, id.indexOf('/')).toLowerCase() : '')
  const want = parts(asked)
  return (
    models
      .filter((id) => id !== asked)
      .map((id) => {
        const have = parts(id)
        const shared = [...have].filter((p) => want.has(p))
        const named = shared.filter((p) => p !== provider(id)).length
        let prefix = 0
        while (prefix < id.length && id[prefix]?.toLowerCase() === asked[prefix]?.toLowerCase()) prefix += 1
        return { id, named, prefix, score: shared.length / new Set([...want, ...have]).size }
      })
      .filter((m) => m.named > 0)
      // Ties (gpt-6-lunar shares gpt and 6 with every gpt-6 model) go to the longest common start.
      .sort((a, b) => b.score - a.score || b.prefix - a.prefix)
      .slice(0, count)
      .map((m) => m.id)
  )
}
