import type { AiProvider } from './ai'
import type { DriveManagerOptions, DriverContract } from 'flydrive/types'

export interface Config {
  database: {
    // A Postgres connection string
    url: string
  }
  // The admin's public address, such as https://cms.example.com, which links in emails and file URLs start from, since a
  // request's Host header can say anything. Invites and reset links are emailed only with this and mail set.
  url?: string
  // The proxies in front of the CMS whose X-Forwarded-For is believed, as addresses and networks such as a CDN's
  // 173.245.48.0/20, for the form limit, the address a submission records and the limits on signing in. Loopback and
  // private networks always are.
  proxies?: Array<string>
  // Where uploaded media is stored: FlyDrive's DriveManager options, whose services are the disks
  storage: Storage
  media?: MediaOptions
  delivery?: DeliveryOptions
  forms?: FormOptions
  // How automations' emails are sent. Email actions fail until it's set.
  mail?: MailOptions
  automations?: AutomationOptions
  webhooks?: WebhookOptions
  // How many versions each entry keeps. Every version is kept if not given.
  versions?: VersionOptions
  // Turns on /mcp, where AI clients such as Claude Code read the site's content as a person, with a token from the
  // admin's MCP tokens page. Off if not given.
  mcp?: boolean | McpOptions
  // Turns on the admin's assistant and its Chat page, which read the site's content with a model from this provider,
  // billed to its account, such as anthropic() from @sorlo/ai-anthropic, or a site's own. Off if not given.
  ai?: AiProvider
  // Whether sorlo dev keeps Sorlo's notes for coding agents in the project's AGENTS.md, pointing them at the docs that
  // come with the installed CMS. On unless false, which leaves AGENTS.md alone.
  agentRules?: boolean
  // The editor's Preview button for each content type, by its name: the address of a page on the site, or a function
  // giving one from the entry's saved draft, or nothing for no preview of that entry. Types left out have no button.
  // It runs on the server, so an address can carry a secret from the environment for the site's preview route.
  previews?: Record<string, Preview | null | undefined>
}

export type Preview = string | ((context: { entry: DraftEntry }) => PreviewUrl | Promise<PreviewUrl>)

// An http or https address, or nothing for no preview
export type PreviewUrl = string | null | undefined

// An entry's saved draft, as the delivery API replies it to a preview key: its values can be unfinished, and one that
// has never been live has no publishedAt
export interface DraftEntry {
  id: string
  type: string
  slug: string | null
  uri: string | null
  parentId: string | null
  position: number | null
  values: Record<string, unknown>
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

// What MCP tokens can be given besides reading and Save drafts
export interface McpOptions {
  // Lets people give their tokens Publish changes, so their AI clients' changes go live on the site at once, with no
  // one reviewing them in the admin. Off if not given.
  publish?: boolean
}

export type Storage = DriveManagerOptions<Record<string, () => DriverContract>>

// What the media library takes, and how it serves files
export interface MediaOptions {
  // MIME types, checked against each file's content, with wildcards such as image/*. Defaults to defaultMediaTypes.
  types?: Array<string>
  // The largest file in bytes, 50 MB if not given. Each upload is held in memory while it's checked.
  maxFileSize?: number
  // The Cache-Control header of served files, public, max-age=3600 if not given
  cacheControl?: string
}

// How deep the delivery API's with resolves links: the fields it names are the first level, and the links of what they
// hold are the next
export interface DeliveryOptions {
  // The levels a request gets when it doesn't send depth, 2 if not given
  depth?: number
  // The most levels a request can ask for, 5 if not given. Each level can multiply the entries a reply holds.
  maxDepth?: number
  // The sites whose JavaScript can read /v1/entries and /v1/media, such as https://example.com. Any site can if not
  // given. A key in a site's pages is public anyway, and servers aren't browsers, so this never stops them.
  origins?: Array<string>
  // The most linked entries and files one reply can hold, counting each place it shows one, 2,000 if not given.
  // Infinity lifts it, which we advise against: a few entries that link to each other can make a reply of gigabytes.
  maxLinks?: number
}

// Who can use the public form routes, and how often
export interface FormOptions {
  // The sites whose JavaScript can call them, such as https://example.com. Any site can if not given. Plain HTML form
  // posts and servers aren't browsers' JavaScript, so this never stops them.
  origins?: Array<string>
  // How many posts an IP address can make in a number of minutes, 10 in 10 if not given. Requests that send an API key
  // with the submit scope, as a site's own server can, aren't limited.
  rateLimit?: { posts?: number; minutes?: number }
  // The most list items one post can hold in all, at any depth, 1,000 if not given, replying 413 past it. Infinity lifts
  // it, which we advise against: anyone can post, and core checks every item of a list with no maximum.
  maxItems?: number
}

// Sends email with the site's own library or service
export interface MailOptions {
  // Who every email comes from, such as Sorlo <cms@example.com>
  from: string
  // Sends one email, such as with nodemailer's sendMail, which takes the message as it is. What it resolves goes in
  // the automation's runs, and what it throws fails the run, to be tried again.
  send: (message: MailMessage) => Promise<unknown>
}

export interface MailMessage {
  from: string
  to: Array<string>
  subject: string
  text: string
  html: string
}

export interface AutomationOptions {
  // How many times an action is tried before it's given up, 6 if not given. Retries wait 1 minute, 5 minutes,
  // 30 minutes, 2 hours, then 12 hours each.
  attempts?: number
}

export interface WebhookOptions {
  // Networks on loopback, private and link-local addresses that webhooks may reach, such as 10.0.0.0/8 for a site's own
  // services or 127.0.0.1 for a test server. Webhooks can't reach any others.
  allowNetworks?: Array<string>
}

export interface VersionOptions {
  // The newest versions each entry keeps besides its named ones and its live one, a whole number from 1. Each save
  // that writes a version deletes the oldest beyond it, so an entry over it shrinks at its next save.
  keep: number
}

// Every format of image, video and audio that a file's content can show, and PDFs
export const defaultMediaTypes = ['image/*', 'video/*', 'audio/*', 'application/pdf']

// Types a site project's sorlo.config.ts
export const defineConfig = (config: Config) => config

// Types a site project's content migrations
export type { AiContent, AiMessage, AiPart, AiProvider, AiReply, AiRequest } from './ai'
export { AiError } from './ai'
export type { ContentMigration, EntryChanges } from './content'
