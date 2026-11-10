# Forms

Forms live in the database rather than in `schema/`, since marketers make them in production. The admin's Forms page creates and edits them with the Sorlo Forms schema builder, which offers every one of its inputs. Each form has a label and a `name`, such as `contact_us`, which the SDK and the generated types call it by.

A site shows a form by pasting the HTML on the form's page into one of its own, or by rendering the fields that [`GET /v1/forms/:form`](api.md#the-delivery-api) replies with [Sorlo Forms](https://github.com/WeAreSorlo/forms). Either posts to the form, as [Submissions](#submissions) describes, the second through the [SDK](sdk.md) if you like.

- Each change to a form's fields saves a new version, and each submission records the version it was checked against, so the inbox shows it with that version's fields. Changing only the label or name keeps the version.
- Each form has an inbox of its submissions, newest first, with Spam and Archive views. Archived submissions can be restored, and any submission can be marked as spam by hand, such as one that got past the honeypot, or as not spam, such as a person's that filled it in.
- A form is open or closed. A closed form keeps its fields and submissions, still serves its fields, and replies 403 to every post until someone opens it on its page, Open form in its panel. Close form takes an open one's submissions away, such as once its event is over. Forms people make start open, and forms made through AI start closed, so nothing they make goes live without a person. The CMS records when each form was first opened, by any of Open form, Apply and publish or its page going live, and leaves it out of replies: over MCP, `update_form` changes only forms that have never been open, since a page may show one that has, and a change there would show at once. Rolling back `000019`, which adds `open`, waits until no form is closed, since without it every form takes submissions.
- The form's page shows HTML for pasting it into any page, which posts to the form with JavaScript off and takes the page's own styles. It posts to the form's ID, so renaming a form never breaks a page it's pasted into. Repeater, matrix, flexible and conditions fields are left out of it, since adding their items needs JavaScript.

## Submissions

`POST /v1/forms/:form` takes a submission, where `:form` is the form's ID or its name. The body is the values themselves, as JSON or as a plain HTML form post, and no key is needed.

- A plain form post names a group's fields as `address.town`, and a list of choices, such as a checkbox field, sends its name again for each one ticked. The text it sends takes each field's type, so `3` is a number and `on` ticks a boolean.
- The values go through `pickValues` and `validateServerValues`, as entries' do. JSON requests, and requests that accept JSON, get JSON replies. A plain form post gets a small page in place of each reply, with the same status and a link back to the page it came from.
- Each submission keeps the form's version, and the IP address, user agent and referer it came with.
- A post of more than 1 MB, or with more than 1,000 list items in all, replies 413 `{ "message": "The submission is too large." }`, or a page saying so. Items count in every list at any depth, such as a repeater's items and the boxes ticked in each, lists the form doesn't have included, before anything reads them, so a post can't make the server check more than 1,000. `forms.maxItems` sets the number, and `Infinity` lifts it, which we advise against: anyone can post, and before this limit a 700 KB post of empty repeater items took about 680 MB of memory to check. A list with a `maximum` bounds the work itself, since a list over its maximum isn't checked item by item, so set maximums on a form's lists before lifting it.

Spam is kept out of the inbox in two ways:

- **A honeypot.** The pasted HTML has a field named `_website`, off screen and out of reach of screen readers and the keyboard. A submission that fills it in is kept as spam and gets the reply any other gets, so a bot can't tell. Field names start with a letter, so no field can take the name.
- **A rate limit.** Each IP address, or an IPv6 address's /64, the usual allocation for one machine or home, with an IPv4 address written as IPv6, such as `::ffff:198.51.100.7`, counting as itself, can make 10 posts in 10 minutes, valid or not, and is then refused with a 429 and `Retry-After` until the time is up. Requests that send an API key with the `submit` [permission](api.md#api-keys) aren't limited, so a site's own server can submit for all its visitors. Other keys count as anyone, since they can sit in a site's pages. Behind a proxy, the address is the one the proxy forwarded for, which the CMS believes only from the proxies in [Behind a proxy](deploying.md#behind-a-proxy).

Any site's JavaScript can call the form routes, unless `forms.origins` in `sorlo.config.ts` lists the sites that can.

```ts
// sorlo.config.ts
export default defineConfig({
  // ...
  forms: {
    origins: ['https://example.com'],
    rateLimit: { posts: 10, minutes: 10 },
    maxItems: 1000,
  },
})
```

| Setting     | What it holds                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `origins`   | The sites whose JavaScript can call the form routes, through CORS. Any site can if not given. Plain HTML forms and servers can always post |
| `rateLimit` | How many `posts` an IP address can make in a number of `minutes`, 10 in 10 if not given                                                    |
| `maxItems`  | The most list items one post can hold in all, 1,000 if not given. `Infinity` lifts it                                                      |

The rate limit counts posts in the CMS's process, so each process behind a load balancer keeps its own count.
