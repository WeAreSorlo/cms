import { createClient } from '@sorlo/sdk'

// A frontend's side of the CMS. `npm run types` pulls src/sorlo-types.d.ts from the running CMS, which then types each
// entry's values
const cms = createClient({
  url: process.env.SORLO_URL ?? 'http://localhost:3000',
  token: process.env.SORLO_TOKEN ?? '',
})

const { data: posts, pagination } = await cms.entries('posts').paginate(10)
console.log(`${pagination.total} posts`)
for (const post of posts) console.log(post.values.title)
