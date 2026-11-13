import { type Found, type LinkedEntry, toHtml } from './html'
import { anyLayout, lexical as field, isJson, orNull } from './logic'
import { isTree, linksOf, mapNodes } from './tree'
import type { InputSchema, InputTypeFields } from '@sorlo/forms'

export type { Found, LinkedEntry, LinkedFile } from './html'

export interface LexicalOptions {
  // Where an entry is on the site, by content type, for links to it in an HTML field, such as
  // { posts: ({ entry }) => `/blog/${entry.slug}` }. A type left out links to its entry's uri or slug from /, and a
  // function giving nothing, such as null, leaves the link's text unlinked.
  entryLinks?: Record<string, (context: { entry: LinkedEntry }) => string | null | undefined>
}

// The field as a plugin of the Sorlo CMS, which includes it, so a site lists lexical() in plugins only for its
// settings. Besides its checks, it says what it links to, and how the delivery API returns it: as HTML, or for JSON
// as stored, with its links swapped for what they link to when with() names it.
export function lexical(options: LexicalOptions = {}) {
  const href = (entry: LinkedEntry) => {
    const address = options.entryLinks?.[entry.type]
    if (address) return address({ entry })
    const path = entry.uri ?? entry.slug
    return path ? `/${path}` : null
  }

  return {
    name: '@sorlo/field-lexical',
    admin: '@sorlo/field-lexical',
    fields: {
      lexical: {
        ...field,
        links: linksOf,
        // shortcut: a JSON field's links load for deliver too, which leaves them as stored; tell the CMS which fields
        // deliver something else if replies with many such links slow down
        deliver: (value: unknown, schema: InputSchema, found: Found) =>
          isJson(schema) ? value : isTree(value, anyLayout) ? toHtml(value, found, href) : null,
        deliveredType: (schema: InputSchema, typeFields: InputTypeFields) =>
          isJson(schema) ? field.typeValue(schema, typeFields) : orNull(schema, 'string'),
        resolve: (value: unknown, schema: InputSchema, found: Found) =>
          isJson(schema) && isTree(value, anyLayout)
            ? mapNodes(value, (node) =>
                node.type === 'entrylink'
                  ? { ...node, entry: found.entries.get(node.entry as string) ?? null }
                  : node.type === 'media'
                    ? { ...node, media: found.media.get(node.media as string) ?? null }
                    : node,
              )
            : value,
      },
    },
  }
}
