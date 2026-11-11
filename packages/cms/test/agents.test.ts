import { agentRules, withAgentRules } from '../src/agents'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

// Sorlo's notes for coding agents in a site project's AGENTS.md, as sorlo dev keeps them

const old = '<!-- BEGIN:sorlo-agent-rules -->\n\nRead the old docs.\n\n<!-- END:sorlo-agent-rules -->'
const crlf = (text: string) => text.replaceAll('\n', '\r\n')

test('the notes make a new AGENTS.md, or go at the end of one, after a blank line', () => {
  expect(withAgentRules()).toBe(`${agentRules}\n`)
  expect(withAgentRules('')).toBe(`${agentRules}\n`)
  expect(withAgentRules('# Ours\n')).toBe(`# Ours\n\n${agentRules}\n`)
  expect(withAgentRules('# Ours')).toBe(`# Ours\n\n${agentRules}\n`)
})

test('old notes are replaced where they are, leaving the rest as it was, and current ones change nothing', () => {
  const updated = withAgentRules(`# Ours\n\n${old}\n\n## Also ours\n\nMore.\n`)
  expect(updated).toBe(`# Ours\n\n${agentRules}\n\n## Also ours\n\nMore.\n`)
  expect(withAgentRules(updated)).toBe(updated)
})

test("a file's CRLF line endings are kept", () => {
  expect(withAgentRules(crlf('# Ours\n'))).toBe(crlf(`# Ours\n\n${agentRules}\n`))
  expect(withAgentRules(crlf(`${old}\n# Ours\n`))).toBe(crlf(`${agentRules}\n# Ours\n`))
})

test('a start marker with no end after it is left to a person', () => {
  expect(withAgentRules('<!-- BEGIN:sorlo-agent-rules -->\n# Ours\n')).toBeUndefined()
  expect(withAgentRules('<!-- END:sorlo-agent-rules -->\n<!-- BEGIN:sorlo-agent-rules -->\n# Ours\n')).toBeUndefined()
})

test('the CLI docs show the notes as they are', () => {
  expect(readFileSync(new URL('../../../docs/cli.md', import.meta.url), 'utf8')).toContain(agentRules)
})
