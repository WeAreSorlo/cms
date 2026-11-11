# People

Everyone who signs in to the admin is on its Users page, from Users in the nav. There are no roles yet, so each of them can do anything there, inviting and removing the others included. The first person makes their own account in the admin, as [The first account](#the-first-account) describes.

```ts
export default defineConfig({
  // ...
  // The admin's address, which the links in invites and reset emails start from
  url: 'https://cms.example.com',
  mail: { from: 'Sorlo <cms@example.com>', send: (message) => transporter.sendMail(message) },
})
```

## The first account

While nobody has an account, the admin shows Make the first account in place of sign-in: a name, an email and a password, and then you're signed in. A code guards it, so whoever finds a fresh site first can't take it. Each server makes one as it starts, and prints it in a link that fills it in:

```
The admin is running at http://localhost:4100/admin/
No one has an account yet. Make the first at http://localhost:4100/admin/#/setup/K7QX-M2PD-9VHT-4CWA
```

- **The code sits in the link's fragment,** which browsers never send, so it stays out of access logs. Opened any other way, the page asks for the code. A wrong one is refused before the password is hashed, so guesses cost the server little, and 80 random bits need no limit on them.
- **Under `sorlo start`,** the link starts from `url`. Without it, the line gives the link's path, `/admin/#/setup/<code>`, to open on the site's address. Hosts show the log in their dashboards.
- **The code changes each time the server starts,** and each instance has its own, which only it takes, so make the first account while one instance runs.
- **The first account closes it for good,** since removed people keep their rows, and two people trying at once make one account between them.
- **`npx sorlo make:user`** makes an account from the terminal instead, such as in a script.

## Settings

`url` is the admin's public address. Links in emails start from it, never from a request's Host header, which anyone can set, so a forged one can't send someone's reset link to another site. Invites and reset links are emailed only with both `url` and [`mail`](automations.md#runs-and-retries) set. Without them, the admin shows each link once, to copy and pass on. `url` takes an `http://` or `https://` address, and `sorlo dev` and `sorlo start` won't start with anything else. The sandbox's comes from `APP_URL`, as [Starting a site](starting-a-site.md) suggests. File URLs start from it too, whatever Host or `X-Forwarded-Proto` a request sends, and `sorlo start` warns when it isn't set.

## The Users page

- **The list** shows everyone who can sign in, by name, with when each last used the admin, written at most once a minute, and when they joined, then the invites waiting. Removed users, in its panel's footer, lists those removed, latest first.
- **Inviting** gives a link that works once, for 7 days. The page shows it once, with Copy, since only its hash is kept, and emails it too where the site sends email, saying whether it went. Inviting an address that has an invite already makes a new link and stops the old one, which is what an invite's New link does, and Delete revokes one. An address with an account can't be invited. The link opens a page like sign-in's, where the person chooses their name and a password of at least 8 characters, then is signed in, with the email they were invited at.
- **Removing** someone, on their page, asks first, then keeps their row, so everything that points at them keeps their name: versions, files, keys and chats. It signs them out everywhere, blanks their password, revokes their MCP tokens, keeping the rows as Revoke does, and deletes their reset link, the reset links they made for others and the invites they sent that still wait, so nobody they invited gets in after them. Nothing they start while being removed outlives it: an invite, an API key, an MCP token or a reset link waits for the removal and is refused, and a save of their account can't give them a password again. The API keys they made keep working, since sites depend on them, and the question names them, to revoke any they shouldn't keep. A chat that a version links to stays readable, read-only, by anyone signed in. Nobody removes themselves, so someone can always sign in, and two people removing each other at once leave one of them.
- **Bringing someone back** is inviting their address again, which the invite page says before it's made: accepting brings back their account, with what it made and its chats. Their revoked tokens stay revoked.
- **Forgot your password?**, under Sign in, emails a link that works once, for an hour, where the site sends email. It replies the same, and at once, whatever the address, so it never tells an account from none, and each person gets at most one email a minute. Choosing a new password with the link signs them out everywhere, then in, and their account page says so, adding that their MCP tokens still work. Without email, someone signed in makes a link on the person's page with Make a reset link, which works the same way. Until roles exist, whoever makes one could use it themselves, so pass it only to the person. Nobody makes one for themselves, since your own password changes only on your account page, with your current password, so a stolen session can't change it. For a site whose only person forgot, `npx sorlo user:password <email>` sets a password, changing nothing if they're removed while it asks.
- **Your account**, from the menu under your name at the foot of the nav, changes your name, email and password in one form. A new email or password needs your current password, and a new password signs you out everywhere else, as Sign out everywhere else does without one. Either ends a reset link of yours that's waiting. A save that lands after you've been removed, or after your password changed elsewhere, such as through a reset link, changes nothing.
- **Limits on guessing.** Sign-in counts each attempt for each email from each address as it arrives, before anything is looked up or hashed, so guesses sent at once can't all get through. An IPv6 address counts by its /64, and an IPv4 address written as IPv6 as itself. After 10 in 10 minutes without a success, which clears them, it replies 429 with `Retry-After`. So one person's typos don't lock out an office behind one address, and nobody can lock someone out from elsewhere. Your current password on your account counts the same way. Forgot your password? takes 20 asks a minute from each address, whatever the emails, and 10 for each email from each address in 10 minutes, and holds at most 50 links waiting to be emailed, replying 429 for a minute past that. The counts are kept in each process, as the forms limit's are, and behind a proxy, each counts the visitor it forwarded for, as [Behind a proxy](deploying.md#behind-a-proxy) says.
