# create-sorlo

## 0.2.0

### Minor Changes

- ac2a7eb: Asks which AI provider the admin's assistant uses, if any, Anthropic or OpenAI. Choosing one installs its package at the CMS's version, writes it into `cms/sorlo.config.ts` as `ai`, and puts the API key it asks for in `cms/.env`. Without a terminal, the assistant is off.

## 0.1.1

### Patch Changes

- fe09deb: The first release published from CI, with provenance. Nothing else changes.
