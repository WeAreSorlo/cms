---
'create-sorlo': minor
---

Asks which AI provider the admin's assistant uses, if any, from those it knows, which is Anthropic so far. Choosing one installs its package at the CMS's version, writes it into `cms/sorlo.config.ts` as `ai`, and puts the API key it asks for in `cms/.env`. Without a terminal, the assistant is off.
