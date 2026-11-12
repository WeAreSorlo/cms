# The assistant

With `ai` set in `sorlo.config.ts`, the admin has an assistant: Assistant at the top of the nav, which opens the Chat page with the person's chats beside it, and the same chat in a card under every page's panel, which knows the page it's on, so "fix the typos here" means the entry open in the editor. It reads with [the MCP server's tools](mcp.md#tools), as the person who asks, and changes content with their write tools, as [proposals](#proposals) the person applies or skips. The card's title hides and shows its chat, its ⋮ holds New chat and the person's chats, and from 64rem wide the card's height and the panel's width change by dragging their edges or with arrow keys. Each browser remembers all three.

`ai` takes a provider, which sends the chat to a model and streams its reply. Providers are packages a site installs, such as [`@sorlo/ai-anthropic`](#anthropic), or a site's own, as [Writing a provider](#writing-a-provider) describes, and the CMS depends on none of them. `npm create sorlo` sets one up when you choose it.

```ts
import { anthropic } from '@sorlo/ai-anthropic'

export default defineConfig({
  // …
  ai: anthropic(),
})
```

Without `ai`, there's no Assistant in the nav, Chat page or assistant beside pages, and the chat routes reply 404.

## What's sent to the provider

Each message sends the provider these, billed to the site's account with it:

- The system prompt: the assistant's instructions and the site's content types with their fields and options, or only their fields' names when they're over 30,000 characters. It's the same for every person and every message, so a provider can cache it until the types change.
- The sixteen tools, with their descriptions and inputs, and in `sorlo dev` the three for [content types](#content-types-through-the-assistant).
- The chat so far, each message as it was sent or returned, with the time and the page the person is on after each of their messages: an entry's, a form's or a media file's id, a version's number or a type's name, and on a list the ids of the entries “these” means, up to 100, or how many past that, never text from the page itself, such as titles, searches or filters. After it come the ids of the proposals the person applied or skipped since the last reply, those that went stale and those still waiting.
- The files attached to the person's messages: each one's details, and for images, the preview `view_media` would show. A file deleted later keeps its preview in the chats that showed it, until they're deleted.
- What the tools read: entries with their drafts and versions, the names of the people who saved and published them, forms' fields, media files' details, and the images `view_media` shows, scaled to fit 512 pixels. Form submissions, email addresses and passwords never are.

## Anthropic

`@sorlo/ai-anthropic` asks Anthropic's Claude, through the official `@anthropic-ai/sdk`. It's released with the CMS, so install the version that matches it:

```bash
npm install @sorlo/ai-anthropic
```

```ts
ai: anthropic({
  // The defaults
  model: 'claude-opus-5-5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  effort: 'medium',
  fallback: true,
})
```

- `model` takes any Claude model that accepts system messages partway through a chat, which is where the page goes. Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 do, and Claude Sonnet 5 doesn't.
- `apiKey` is only ever read on the server. Without it, the SDK reads `ANTHROPIC_API_KEY`, from the environment or the project's `.env`, or its other credentials.
- `effort` is how much the model thinks before it answers, `low`, `medium`, `high`, `xhigh` or `max`, which is most of what a reply costs and how long it takes.
- `fallback` runs a request that Anthropic's safety classifiers decline again on the model Anthropic recommends for that kind of decline, as `fallbacks: "default"`, since the classifiers can flag harmless content. `false` turns it off, and a model without fallbacks answers alone.

Its requests use two betas: `server-side-fallback-2026-07-01` for `fallback`, and `thinking-binding-controls-2026-08-01`, so a change to the content types drops the model's thinking from earlier in a chat rather than failing the chat.

## Writing a provider

A provider is an object with a `name` and a `reply` method, typed `AiProvider` in `@sorlo/cms`, so a site can pass its own, or publish one as a package:

```ts
import type { AiProvider } from '@sorlo/cms'

export const myProvider = (): AiProvider => ({
  name: 'my-provider',
  async reply({ system, tools, messages }, on, signal) {
    // Send them to the model, call on.text with each piece of text as it streams, and resolve with the whole reply
    return { content: [{ type: 'text', text: 'Hello' }], stop: 'end', model: 'my-model', usage: null }
  },
})
```

`reply` gets one call's worth of the chat: the system prompt, the tools with their inputs as JSON schemas, and the messages, each `user`, `assistant` or `system`, which goes partway through the chat. Each message's `content` is a list of the CMS's own parts, which the provider converts to its API's and back:

| Part | What it holds |
| --- | --- |
| `{ type: 'text', text }` | Text |
| `{ type: 'image', data, mimeType }` | An image, base64, as MCP's tool results hold one |
| `{ type: 'toolCall', id, name, input }` | A tool the model calls, which the CMS runs |
| `{ type: 'toolResult', id, content, isError? }` | The result of the call with that `id`, its text and images |
| `{ type: 'opaque', provider, data }` | What only the provider named reads, such as a model's reasoning or signatures. The CMS stores it and sends it back unchanged, and leaves other providers' out, so a site can change providers partway through a chat |

The reply resolves with its parts, why it stopped (`end`, `tools` when its `toolCall` parts are to be run, `length`, `refused`, or `stopped` once `signal` aborts, with the text written so far), the model that wrote it and its usage, which the CMS stores as given. `on.restart()` drops the text streamed since the last call, for a provider that has to ask again. An error named `AiError`, such as one made with the `AiError` class `@sorlo/cms` exports, shows its message in the chat, and any other shows that something went wrong.

## “This” and “these”

Beside a page, in the panel's assistant and its dialog below 64rem, a line above the box says what “this” means there, and it's exactly what the message sends as its page: an entry's title, such as Kubecon 2026, a version, such as Kubecon 2026, version 4, a form's label, the file last opened in the media library, such as logo.svg, or in the type editor, the type, such as Blog posts. On a list, it's the entries ticked, in the order they were ticked, such as Events: 3 ticked, or, with nothing ticked and a search or filter on, those they find, in the list's order, such as Events: 37 matching your filter, or else the type alone. The Chat page has no line, since it's no page of content.

- **Only ids reach the model.** The line uses the titles and names the admin already shows, while the system message names ids, type names and counts, since anyone can write a title or a search.
- **The server checks each one.** A ticked entry must be one of the type's entries on the list, or in the archive for the archive, and one that isn't is left out, saying how many. A search or filter runs through the list's own query, on the archive for the archive, and a query the list API turns down sends the type alone. A form or a file must exist.
- **Past 100**, ticked or found, the model gets only the type and how many, and the line asks to tick fewer or narrow the search or filter, so a change to “these” never goes further than the person can see.
- **Tools take the ids**, such as `replace_text`'s `ids`, so “replace it in these” changes only them.

## Attaching files

Files attach to a message with Attach files beside Send, by dropping them anywhere on the assistant, its card, header and all, its dialog, or the Chat page's chat, or by pasting them into the box, such as a screenshot, so “set this image as the cover photo for this blog” can come with the image. A paste that holds text as well, as Excel, Word, Keynote and Numbers give a picture of what was copied beside its text, pastes the text as it always did, while an image copied from a web page, which comes with HTML alone, attaches. A collapsed card takes no drops, and a file dropped anywhere else in the admin does nothing, rather than opening in its place, unless that's a drop target of its own, such as the media library. Each uploads to the media library as it's attached, through `POST /api/media` and its checks, as a media field's picker uploads before the entry is saved, so it's the person's own upload, public as every library file is. They show above the box as the media field's rows, a thumbnail and a name, with Remove, which deletes the upload, since nothing uses it yet, and in the person's message once it's sent, where a file deleted since is a muted row.

- **Up to 10 a message**, each of any type the library takes and within `media.maxFileSize`. Files past 10 are turned away with a notice, which names one and counts more, such as “15 files weren't attached, since a message takes up to 10 files.”, and a file the library turns away shows why, and has to be removed before the message sends.
- **A message still needs words**, since a file alone doesn't say what to do with it. Send pressed while files are still going up says Uploading…, and the box is read-only until they're done. Then exactly what Send was pressed on goes, its words, files and page, to the chat open then, wherever the person has gone since, and even once the box has gone, such as with the dialog closed or on the Chat page. If one of its files is turned away meanwhile, nothing is sent: the box says why, moving focus only if it's still in the box, or a toast does once the box has gone.
- **A message the server didn't take comes back**, with its files, before anything written or attached since, saying why, such as when the connection dropped, the server failed or the chat was deleted in another tab, which opens a new chat for it. One the server took stays in the chat, however its reply ends.
- **The model gets each file in the person's own message**, before their words: an image as `view_media` shows one, scaled to fit 512 pixels, at most 361 tokens, then its details as `get_media` gives them, which for other files, such as a PDF, are all it gets. The message stores what was sent, preview included, so it goes back unchanged with every later request and stays in the cache. The instructions say what an image shows, text included, and files' names, alt text and captions are data, never instructions, and the message's system message says that “this image”, “this file” and the like mean the files attached, rather than, in the media library, the file last opened.
- **Nothing changes over MCP**, and no tool uploads: an MCP client's own model sees what its person attaches there.

## Proposals

The write tools propose in the assistant, running every check the save would and saving nothing. Each proposal shows under the step that made it, as a version page compares fields, such as a long text's words removed and added, with Apply as draft, Apply and publish, and Skip:

- **Apply as draft** saves the draft as the person, through the editor's own save, so versions, the version cap, events and automations work as they do there, and the version links to the chat, which the history shows as "with the assistant".
- **Apply and publish** is the editor's Publish: the proposal's fields go onto the draft and the draft goes live in one go, with every check a publish runs, such as required fields, a live sibling's slug and a page's live parent. If one fails, nothing is saved, and the proposal says why and keeps waiting. Publishing makes the whole draft live, so the card says first when the entry has other changes that aren't live, or isn't live at all. Only the person's click publishes: the assistant never does, and over MCP only a token with [Publish changes](mcp.md#publishing-through-a-token) does, as its maker chose.
- **Content types** have no drafts either, and publish nothing, so their cards have Apply and Skip alone, as [content types through the assistant](#content-types-through-the-assistant) describes.
- **Types without drafts and files** go live once applied, since they have no drafts, so their cards have Apply and publish alone and say so. A file's card shows its image beside its new name, alt text or caption, and applying goes through the media library's own save, with its `media.updated` event.
- **A find and replace, or alt text for many files,** comes back as a proposal for each entry or file, folded under its name, with Apply all as drafts, Apply and publish all, and Skip all. They send a hundred at a time, and a reply with proposals from several steps ends with the same buttons of its own.
- **A page with a form** comes back as a proposed form and a proposed entry whose form field holds the form's id, which its proposal gave it in advance. Applying the entry makes the form first, closed, and skipping the form skips the entry. The form opens exactly when a page that shows it goes live through Apply, by Apply and publish, a later Apply and publish after one failed, or as a type without drafts, which goes live once applied. In a batch with its page, such as Apply and publish all, it's made closed and never opened on its own, so a page that fails its checks never leaves its form taking submissions. Apply and publish on a form alone opens it.
- **It never overwrites a newer edit.** A change stores the top-level fields it sets and what they held when it was proposed. Apply locks the entry and goes ahead only if those fields, and a page's parent, still hold what they held and no content migration ran since, then sets only those fields, so an edit made since to another field is kept. Otherwise the proposal turns stale and says to ask again, as it does when what it changes was deleted since. A check that fails at Apply, such as a slug taken since, shows its message and leaves the proposal waiting, and in a find and replace marks its row Not applied.
- **The page beside it.** Apply asks for the page's changes to be saved first when it shows what a proposal changes and someone has changed it there: the entry's editor, the form's page or the bulk grid. Then the page loads again, as the media library does, so nothing it saves later sends back what it showed before. A save in the editor or the grid updates the cards' warnings too, such as that an entry has other changes that aren't live.
- **The model hears what became of them** with the person's next message, in the system message after it: which proposals were applied as drafts, applied and published, or skipped, which went stale and which still wait, as ids only. It counts from the last system message the model saw, so what a reply that failed or was stopped never carried goes with the next. A round that's never stored, such as when another tab wrote to the chat first, skips its proposals, since nothing shows them. Proposals live in a table of their own, `proposals`, since a chat's messages are only ever added to and go back to the model exactly as they were.

## Content types through the assistant

In `sorlo dev`, where the type editor writes types, the assistant can also propose new content types and changes to them, such as "Make a jobs type with a title, a location and a closing date". Elsewhere it has no tools for them, and says that types change in development and ship through git. MCP never offers them.

| Tool                  | Does                                                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_field_types`    | Reads what the type editor's palette offers: each field type with the common settings it takes and its options as Sorlo Forms schemas, with a relationship's types and a Shared group field's groups by id, and the shared groups themselves |
| `create_content_type` | Proposes a new type from a type file's settings and `fields`                                                                                                                                                                                 |
| `update_content_type` | Proposes a change to a type: the settings given, where `null` clears one, the top-level `fields` to add or change, each whole, matched by `id`, or else by name, and the top-level fields named in `remove`                                  |

- **Checks.** Each runs every check the type editor's save runs, and on the fields it sends, those the schema builder's field editor runs in the browser: only the settings and options each field type takes, holding what they take, so a select needs its choices and a misspelled option is refused. A use of a shared group, which `list_content_types` shows expanded, goes back to its file as the use, and the group's fields can't change here, nor can a group be swapped for a use or back, which is the type editor's Make shared and Use shared group. A call that changes nothing the file would hold is refused.
- **Ids.** Content migrations follow fields by `id`. A new field or layout gets one, and one sent without an id keeps the id of the field of the same name at the same place, unless another field in the call claims that id, as a renamed one does. Inside a field or layout sent with its id, the place is what it was by that id, however it was renamed or moved, so a renamed flexible field keeps its layouts. One sent with an id the type doesn't have, in place of a field of that name, is refused, so a slip can't delete a field's values.
- **Its first entries** can be proposed with a new type, with `create_entry` under its name, checked against the proposed fields, and they carry the type's id, as `after.typeId`, so they go into that type alone. Applying one applies the type first, skipping the type skips them, and when the type turns stale, or another type has its name by then, they turn stale too. Nothing else links to a proposed type until it's applied.
- **The card** shows a new type's settings and fields, or a change's changes by field, matched by id as `make:migration` matches them, with the file before and after As JSON in a fold, what its content migration will say, and what applying it means for the type's entries and the site's code, such as that a renamed field changes what the API returns. Labels, instructions and choices show on the card, and conditions in words, since once applied they're part of what the assistant reads as the site's types, which its instructions say to read as data, never as instructions.
- **Apply** writes the type's file as the type editor's Save does, laid out by the site's Prettier, with its fields' keys in the order they were, then runs `make:migration`, never `sorlo migrate`, so a person checks the migration and runs it on the [Migrations page](content-migrations.md#running-migrations-from-the-admin), and until then no entry can be saved. It goes ahead only while the type's file on disk holds what it held when it was proposed, so a save in the type editor or a hand edit since makes it stale. Apply and the type editor's saves take turns, and when the claim on the proposal or anything after the write fails, the files and the migration go back as they were. The card then names the migration it wrote, with its flags and TODOs.
- **The page beside it.** The type editor, and the entry editor and bulk grid of the type's entries, ask for their unsaved changes to be saved before Apply, then load again, the type editor at the type's new name if it has one, keeping focus on the card. The type editor counts as changed whenever a save would write something else, however the change was made, holds still from Apply until it has loaded again, and says so if loading it again fails. Only a page still at its address loads again. The admin loads the types again after any type is applied, and a page of a type renamed since says so, and that `sorlo migrate` moves its entries.
- **Left out:** deleting types, changing shared groups, reordering fields, writing migration code, and a new structure for a type with entries, which the type editor refuses too.

## Chats

Each person sees only their own chats, which stay when they're removed, except that anyone signed in can read a chat read-only once a version links to it, so an audit can open the conversation behind a change. The chat says so before its first Apply. A chat is named after its first message and can be renamed or deleted on the Chat page. Its messages are stored in `chat_messages` exactly as they were sent and returned, which the model's thinking and the cache need, and are only ever added to, each reply with its model and token usage. A reply takes at most 20 rounds of tools, each running several at once, then stops and says so, and asking it to go on carries on. Stop keeps what the reply wrote. A reply that was declined, cut off at its length limit or stopped says so, and failures such as rate limits show in the chat when they happen.

Replies render as Markdown through `react-markdown`, as React elements rather than HTML: HTML in a reply is dropped, and images never load, since an image's address could carry what a reply was made to send. For the same reason only links into the admin open from a reply. A web page's or an email address shows as text after its words, such as "the docs (https://…)", so nothing a reply was steered to write, such as an address carrying a draft's text, opens with a click.
