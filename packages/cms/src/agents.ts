// Sorlo's notes for a site's coding agents, which sorlo dev keeps in the site project's AGENTS.md between these
// markers, as next dev keeps Next's, pointing them at the docs that come with the installed CMS
export const agentRulesStart = '<!-- BEGIN:sorlo-agent-rules -->'
const end = '<!-- END:sorlo-agent-rules -->'

export const agentRules = [
  agentRulesStart,
  "## Sorlo isn't in your training data",
  "This project's CMS is Sorlo, `@sorlo/cms`, which is newer than your training data, so don't guess its APIs, file formats or commands. Before you change content types or shared groups in `schema/`, content migrations in `migrations/`, `sorlo.config.ts` or calls to `@sorlo/sdk`, read the pages that cover them in `node_modules/@sorlo/cms/docs/`, starting from its `README.md`, which lists them all. Fields and their options are Sorlo Forms inputs, which the README in `node_modules/@sorlo/forms/` describes. Both match the installed versions. Look for them from this file's folder upward, since in a workspace they can be in a parent folder's `node_modules`.",
  "`sorlo dev` writes this block, and writes it again when it's missing or out of date, as `docs/cli.md` in `@sorlo/cms` explains. Taking it out of a diff only brings it back, so commit it with your work.",
  end,
].join('\n\n')

// An AGENTS.md with the notes added at its end, or brought up to date between their markers, leaving the rest as it
// was, in the file's own line endings. Undefined for a start marker with no end after it, where only a person can tell
// where the old notes stopped.
export function withAgentRules(file = '') {
  const eol = file.includes('\r\n') ? '\r\n' : '\n'
  const notes = agentRules.replaceAll('\n', eol)
  const from = file.indexOf(agentRulesStart)
  if (from === -1) return file + (!file ? '' : file.endsWith('\n') ? eol : eol + eol) + notes + eol
  const to = file.indexOf(end, from)
  return to === -1 ? undefined : file.slice(0, from) + notes + file.slice(to + end.length)
}
