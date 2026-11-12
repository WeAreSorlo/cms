# @sorlo/ai-anthropic

Anthropic's Claude as the AI provider of the [Sorlo CMS](https://github.com/WeAreSorlo/cms)'s assistant, through the official `@anthropic-ai/sdk`. It's released with the CMS, so install the version that matches the site's `@sorlo/cms`.

```bash
npm install @sorlo/ai-anthropic
```

```ts
import { anthropic } from '@sorlo/ai-anthropic'
import { defineConfig } from '@sorlo/cms'

export default defineConfig({
  // …
  ai: anthropic({ model: 'claude-opus-5-5' }),
})
```

Without `apiKey`, it reads `ANTHROPIC_API_KEY`. The CMS's [docs on the assistant](https://github.com/WeAreSorlo/cms/blob/main/docs/assistant.md#anthropic) have its options, and how to write a provider for another API.

## License

MIT
