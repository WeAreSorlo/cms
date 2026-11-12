---
'@sorlo/cms': minor
'@sorlo/ai-anthropic': minor
---

`ai` in `sorlo.config.ts` takes a provider rather than options, so a site brings its own: `ai: anthropic()` from the new `@sorlo/ai-anthropic`, which holds what the CMS did for Anthropic, or any object with a `name` and a `reply` method, typed `AiProvider`. The CMS no longer depends on `@anthropic-ai/sdk`. Messages are made of the CMS's own parts, which a migration converts stored chats to, and `@sorlo/cms` exports their types and `AiError`. A config that still has `{ provider: 'anthropic' }` stops `sorlo` with what to change.
