import { lexical } from '../src/plugin'
import { block, layouts, paragraph, text, tree } from './fixtures'
import { describe, expect, it } from 'vitest'

const post = { id: '0192', type: 'posts', slug: 'hello', uri: null, values: {} }
const page = { id: '0194', type: 'pages', slug: 'team', uri: 'about/team', values: {} }
const cat = {
  id: '0193',
  name: 'cat.jpg',
  mime: 'image/jpeg',
  url: 'https://cms.example.com/media/0193/cat.jpg',
  width: 800,
  height: 600,
  alt: 'A "cat"',
  caption: 'Our cat',
}
const found = { entries: new Map([post, page].map((entry) => [entry.id, entry])), media: new Map([[cat.id, cat]]) }
const schema = { name: 'body', type: 'lexical' }
const json = { name: 'body', type: 'lexical', options: { output: 'json', layouts } }

describe('rich text delivered as HTML', () => {
  const { lexical: richtext } = lexical({ entryLinks: { posts: ({ entry }) => `/blog/${entry.slug}` } }).fields

  it('writes plain elements, escaping text and attributes', () => {
    const value = tree(
      { type: 'heading', tag: 'h2', children: [text('Tom & <Jerry>')] },
      paragraph(text('bold', 1), text(' and '), text('both', 3), { type: 'linebreak' }, text('code', 16)),
      { type: 'quote', children: [text('Quoted')] },
      {
        type: 'list',
        listType: 'number',
        start: 3,
        children: [
          { type: 'listitem', children: [text('Three')] },
          {
            type: 'listitem',
            children: [
              { type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [text('Inner')] }] },
            ],
          },
        ],
      },
      { type: 'code', language: 'js"><script>', children: [text('a < b'), { type: 'linebreak' }, text('c')] },
      paragraph(),
    )
    expect(richtext.deliver(value, schema, found)).toBe(
      '<h2>Tom &amp; &lt;Jerry&gt;</h2>' +
        '<p><strong>bold</strong> and <em><strong>both</strong></em><br><code>code</code></p>' +
        '<blockquote>Quoted</blockquote>' +
        '<ol start="3"><li>Three</li><li><ul><li>Inner</li></ul></li></ol>' +
        '<pre><code class="language-jsscript">a &lt; b\nc</code></pre>',
    )
  })

  it('links to addresses, and to entries by the site’s entryLinks, their uri or slug, or not once they’re gone', () => {
    const value = tree(
      paragraph(
        { type: 'link', url: 'https://example.com', target: '_blank', children: [text('out')] },
        { type: 'entrylink', entry: '0192', children: [text('a post')] },
        { type: 'entrylink', entry: '0194', children: [text('the team')] },
        { type: 'entrylink', entry: 'gone', children: [text('a draft')] },
      ),
    )
    expect(richtext.deliver(value, schema, found)).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer" target="_blank">out</a>' +
        '<a href="/blog/hello" data-entry="0192">a post</a>' +
        '<a href="/about/team" data-entry="0194">the team</a>' +
        'a draft</p>',
    )
  })

  it('leaves a link unlinked when entryLinks gives nothing, or an unsafe address', () => {
    const { lexical: richtext } = lexical({
      entryLinks: { posts: () => null, pages: () => 'javascript:alert(1)' },
    }).fields
    const value = tree(
      paragraph(
        { type: 'entrylink', entry: '0192', children: [text('a post')] },
        { type: 'entrylink', entry: '0194', children: [text('the team')] },
      ),
    )
    expect(richtext.deliver(value, schema, found)).toBe('<p>a postthe team</p>')
  })

  it('shows files: images in a figure with their caption, players for video and audio, and links for others', () => {
    const files = new Map<string, any>([
      ['0193', cat],
      ['v', { id: 'v', name: 'clip.mp4', mime: 'video/mp4', url: '/clip.mp4', width: 640, height: 360 }],
      ['a', { id: 'a', name: 'song.ogg', mime: 'audio/ogg', url: '/song.ogg' }],
      ['d', { id: 'd', name: 'terms.pdf', mime: 'application/pdf', url: '/terms.pdf' }],
      ['plain', { ...cat, id: 'plain', alt: null, caption: null }],
    ])
    const value = tree(...[...files.keys(), 'gone'].map((media) => ({ type: 'media', media })))
    expect(richtext.deliver(value, schema, { entries: new Map(), media: files })).toBe(
      '<figure><img src="https://cms.example.com/media/0193/cat.jpg" alt="A &quot;cat&quot;" width="800" height="600">' +
        '<figcaption>Our cat</figcaption></figure>' +
        '<video src="/clip.mp4" controls="controls" width="640" height="360"></video>' +
        '<audio src="/song.ogg" controls="controls"></audio>' +
        '<p><a href="/terms.pdf">terms.pdf</a></p>' +
        '<img src="https://cms.example.com/media/0193/cat.jpg" alt="" width="800" height="600">',
    )
  })

  it('says what it links to, and types its delivered value as a string', () => {
    const value = tree(paragraph({ type: 'entrylink', entry: '0192', children: [text('x')] }), {
      type: 'media',
      media: '0193',
    })
    expect(richtext.links(value)).toEqual({ entries: ['0192'], media: ['0193'] })
    expect(richtext.links('nope')).toEqual({ entries: [], media: [] })
    expect(richtext.deliveredType({ ...schema, required: true }, () => '{}')).toBe('string')
    expect(richtext.deliveredType(schema, () => '{}')).toBe('string | null')
    expect(richtext.deliver(null, schema, found)).toBeNull()
  })
})

describe('rich text delivered as JSON', () => {
  const { lexical: field } = lexical().fields

  it('is delivered as stored, typed as its tree', () => {
    const value = tree(paragraph({ type: 'entrylink', entry: '0192', children: [text('x')] }))
    expect(field.deliver(value, json, found)).toBe(value)
    expect(field.deliveredType({ ...json, required: true }, () => '{}')).toContain("{ type: 'block'; version: number")
    expect(field.resolve(value, schema, found)).toBe(value)
  })

  it('swaps the IDs in its nodes for what they link to, with null for what’s gone', () => {
    const value = tree(
      paragraph({ type: 'entrylink', entry: '0192', children: [text('x')] }),
      { type: 'media', media: 'gone' },
      block({ _layout: 'callout', title: 'Hi' }),
    )
    expect(field.resolve(value, json, found)).toEqual(
      tree(
        paragraph({ type: 'entrylink', entry: post, children: [text('x')] }),
        { type: 'media', media: null },
        block({ _layout: 'callout', title: 'Hi' }),
      ),
    )
  })
})
