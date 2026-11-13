# @sorlo/ai-openai

## 0.2.0

### Minor Changes

- ee8ba1f: The new `@sorlo/ai-openai` makes OpenAI's models the assistant's provider, with `ai: openai()`, through the official `openai` SDK and OpenAI's Responses API. It asks `gpt-6-astra` at `medium` effort unless `model` and `effort` say otherwise, and reads `OPENAI_API_KEY` without `apiKey`. OpenAI keeps no copy of the chats, and their reasoning goes back to it encrypted, as it came.
