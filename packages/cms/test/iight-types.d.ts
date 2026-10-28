// Generated from the CMS by `npx iight types pull`. Pull again rather than editing it.

export type BlogValues = {
  title: string
  slug: string
  published_at?: string
  featured?: boolean
  views?: number
  blocks?: Array<{ _layout: "text" } & {
    body: string
  }>
}

export type EntryBlog = {
  id: string
  type: "blog"
  slug: string
  uri: null
  parentId: null
  position: null
  values: BlogValues
  createdAt: string
  updatedAt: string
}

export type DocsValues = {
  title: string
  slug: string
}

export type EntryDocs = {
  id: string
  type: "docs"
  slug: string
  uri: string
  parentId: string | null
  position: number
  values: DocsValues
  createdAt: string
  updatedAt: string
}

export type HomeValues = {
  headline: string
  intro?: string
}

export type EntryHome = {
  id: string
  type: "home"
  slug: null
  uri: null
  parentId: null
  position: null
  values: HomeValues
  createdAt: string
  updatedAt: string
}

declare module '@iight/sdk' {
  interface EntryTypes {
    blog: EntryBlog
    docs: EntryDocs
    home: EntryHome
  }
}

export {}
