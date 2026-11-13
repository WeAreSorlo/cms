# @sorlo/ai-openai

OpenAI's models as the AI provider of the [Sorlo CMS](https://github.com/WeAreSorlo/cms)'s assistant, through the official `openai` SDK and OpenAI's Responses API. It's released with the CMS, so install the version that matches the site's `@sorlo/cms`.

```bash
npm install @sorlo/ai-openai
```

```ts
import { openai } from '@sorlo/ai-openai'
import { defineConfig } from '@sorlo/cms'

export default defineConfig({
  // …
  ai: openai({ model: 'gpt-6-astra' }),
})
```

Without `apiKey`, it reads `OPENAI_API_KEY`, which is a key from the OpenAI API platform, billed apart from any ChatGPT subscription. The CMS's [docs on the assistant](https://github.com/WeAreSorlo/cms/blob/main/docs/assistant.md#openai) have its options, and how to write a provider for another API.

## License

MIT
