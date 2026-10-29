import { expect, test } from 'claude-code/testing'
import { codex } from '../hooks/adapters/codex'
import { helpOf } from '../hooks/prompt'

test('Codex help identifies native mailbox pre-dispatch aborts without suggesting automatic retries', () => {
  const help = helpOf(codex, [])
  expect(help).toContain('aborted before dispatch')
  expect(help).toContain('mailbox')
  expect(help).toContain('Inspect')
  expect(helpOf({ ...codex, name: 'pi' }, [])).not.toContain('aborted before dispatch')
})
