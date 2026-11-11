# Automations

An automation runs actions, such as sending an email or calling a webhook, when something changes in the CMS. The admin's Automations page creates and edits them, and shows each one's runs. An automation has:

- **Triggers**, one or more of the [events](#events).
- **Conditions**, the conditional logic of Sorlo Forms, checked against the event's data and edited with its `conditions` input. Any group can match, and a group matches when all its rules do. A rule's field is a path into the data, picked from a list: `entry.type`, `form.id`, `form.name`, `submission.spam` and `media.mime`, then each type's top-level fields as `entry.values.<name>` and each form's as `submission.values.<name>`, by label, such as "Blog posts › Featured". The list holds only the data of the events ticked in When: `entry.*` for entry events, `form.*` and `submission.*` for a form submitted, and `media.*` for file events. Each field's type decides the operators, and a choice field's choices, a type, a form or a yes or no are picked from a list too. The routes check rules against the same list, so a rule on a field that's gone is refused until it's changed. Values compare as text, so `false` matches `"spam": false`. With no groups, every event it's triggered by runs it.
- **Actions**, run in order. They're the blocks of a flexible field, so each action's settings are a Sorlo Forms schema, in [`packages/cms/src/schemas.ts`](../packages/cms/src/schemas.ts), and [`packages/cms/src/actions.ts`](../packages/cms/src/actions.ts) runs it.

| Action         | Settings                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Send an email  | `to`, addresses separated by commas, and `subject`, which says what happened if it's left empty, such as "New submission: Contact us". The email lists the record's fields by their labels |
| Call a webhook | `url`, a signing `secret`, which saving makes when it's left empty, `headers` to send, such as `Authorization`, and a `timeout` in seconds for the reply, from 1 to 30 and 10 if not given |

A form's page lists the automations its submissions can run, with a link that starts one that emails them, skipping spam. It's an automation like any other, so it can call a webhook too.

## Events

Every change writes an event, in the same transaction as the change, so an event is kept exactly when its change is. A worker in the server's own process hands each event to the automations it triggers and runs their actions.

| Event                                               | Written when                                                                                                                                                                                       | Its data                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `entry.created`, `entry.updated`                    | An entry is saved or moved among its siblings. Each page whose `uri` or position changes with it gets one too                                                                                      | `{ entry }`, as the admin API returns it                     |
| `entry.published`, `entry.unpublished`              | An entry's live copy is made or changed, by Publish or by moving a page among its siblings, or taken down, by Unpublish or Archive. Each live page that changes or goes along with it gets one too | `{ entry }`, as the admin API returns it                     |
| `entry.archived`, `entry.restored`, `entry.deleted` | An entry is archived, restored or deleted, with one for each page that goes along with it                                                                                                          | `{ entry }`, as it was left                                  |
| `submission.created`                                | A form takes a submission, spam included                                                                                                                                                           | `{ form: { id, name, label }, submission }`, with its `spam` |
| `media.created`, `media.updated`, `media.deleted`   | A file is uploaded, edited or deleted                                                                                                                                                              | `{ media }`, with its `url`                                  |

Content migrations write no events. `entry.updated` comes with every draft save, so a site that rebuilds when its content changes should listen for `entry.published` and `entry.unpublished` instead.

## Webhooks

A webhook gets a `POST` of the event as JSON. `id` is the event's ID, which stays the same on every try, so a receiver can drop the ones it already has.

```json
{
  "id": "0192f0c4-…",
  "event": "submission.created",
  "createdAt": "2026-10-28T12:00:00.000Z",
  "data": { "form": { "id": "0192f0c4-…", "name": "contact_us", "label": "Contact us" }, "submission": { "…": "…" } }
}
```

Requests are signed the [Standard Webhooks](https://www.standardwebhooks.com) way, with `webhook-id` (the event's ID), `webhook-timestamp` and `webhook-signature`, which is `v1,` and a base64 HMAC-SHA256 of `<id>.<timestamp>.<body>`, keyed with the bytes of the secret after `whsec_`. Its libraries check them in most languages:

```ts
import { Webhook } from 'standardwebhooks'

// Throws unless the request is signed with the secret, and recent
const event = new Webhook(secret).verify(body, headers)
```

- A reply from 200 to 299 succeeds. Anything else fails, redirects included, which aren't followed. The first 2000 characters of the reply go in the runs.
- Webhooks can't reach loopback, private, link-local or shared addresses, cloud metadata services among them, unless `webhooks.allowNetworks` lists the network. A name is checked by the address it resolves to, and the request goes to that address, so it can't resolve somewhere else in between.

## Runs and retries

Each try of each action is a run, which the automation's runs page lists, newest first, with what came back or why it failed.

- An action that fails is tried again 1 minute, 5 minutes, 30 minutes, 2 hours, then 12 hours later, 6 tries in all unless `automations.attempts` says otherwise. An action that's still failing holds back the ones after it, and once its tries run out, they don't run.
- Each try runs the action as it is then, so fixing a webhook's URL counts from its next try.
- An action runs at least once. A crash partway through can run it again, which is why receivers should drop event IDs they've seen.
- Each process takes events and runs with `SKIP LOCKED`, so two processes on one database never take the same one. A process runs one action at a time.

```ts
// sorlo.config.ts
import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({ host: 'smtp.example.com', port: 587, auth: { user, pass } })

export default defineConfig({
  // ...
  mail: { from: 'Sorlo <cms@example.com>', send: (message) => transporter.sendMail(message) },
  automations: { attempts: 6 },
  webhooks: { allowNetworks: ['10.0.0.0/8'] },
})
```

| Setting                  | What it holds                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail.from`              | Who emails come from                                                                                                                                                                                                                     |
| `mail.send`              | Sends one email, `{ from, to, subject, text, html }` with `to` a list of addresses, which nodemailer's `sendMail` takes as it is. What it resolves goes in the runs, and what it throws fails the try. Email actions fail until it's set |
| `automations.attempts`   | How many times an action is tried before it's given up, 6 if not given                                                                                                                                                                   |
| `webhooks.allowNetworks` | The internal networks webhooks may reach, such as `10.0.0.0/8` for a site's own services, or an address such as `127.0.0.1`                                                                                                              |

The sandbox's `send` prints each email in the terminal, and it allows webhooks to this machine.
