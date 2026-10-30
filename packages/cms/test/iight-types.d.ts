// Generated from the CMS by `npx iight types pull`. Pull again rather than editing it.

import type { Entry, Linked, Media } from '@iight/sdk'

export type GroupOg = {
  image?: string
  alt?: string
}

export type GroupOgResolved<Depth extends number> = {
  image?: Media | null
  alt?: string
}

export type GroupSeo = {
  title: string
  share?: GroupOg
}

export type GroupSeoResolved<Depth extends number> = {
  title: string
  share?: GroupOgResolved<Depth>
}

export type GroupMeta = {
  noindex?: boolean
}

export type BlogValues = {
  title: string
  slug: string
  published_at?: string
  featured?: boolean
  views?: number
  blocks?: Array<{ _layout: "text" } & {
    body: string
  } | { _layout: "gallery" } & {
    images: Array<string>
  }>
  author?: string
  cover?: string
  related?: Array<string>
  credits?: Array<{
    person: string
    role?: string
  }>
}

export type BlogResolvedValues<Depth extends number> = {
  blocks?: Array<{ _layout: "text" } & {
    body: string
  } | { _layout: "gallery" } & {
    images: Array<Media>
  }>
  author?: Linked<EntryAuthors, Depth> | null
  cover?: Media | null
  related?: Array<Linked<EntryBlog, Depth>>
  credits?: Array<{
    person: Linked<EntryAuthors, Depth> | null
    role?: string
  }>
}

export type EntryBlog = Omit<Entry, 'type' | 'slug' | 'uri' | 'parentId' | 'position' | 'values'> & {
  type: "blog"
  slug: string
  uri: null
  parentId: null
  position: null
  values: BlogValues
}

export type DocsValues = {
  title: string
  slug: string
}

export type DocsResolvedValues<Depth extends number> = {}

export type EntryDocs = Omit<Entry, 'type' | 'slug' | 'uri' | 'parentId' | 'position' | 'values'> & {
  type: "docs"
  slug: string
  uri: string
  parentId: string | null
  position: number
  values: DocsValues
}

export type HomeValues = {
  headline: string
  intro?: string
}

export type HomeResolvedValues<Depth extends number> = {}

export type EntryHome = Omit<Entry, 'type' | 'slug' | 'uri' | 'parentId' | 'position' | 'values'> & {
  type: "home"
  slug: null
  uri: null
  parentId: null
  position: null
  values: HomeValues
}

export type AuthorsValues = {
  name: string
  avatar?: string
}

export type AuthorsResolvedValues<Depth extends number> = {
  avatar?: Media | null
}

export type EntryAuthors = Omit<Entry, 'type' | 'slug' | 'uri' | 'parentId' | 'position' | 'values'> & {
  type: "authors"
  slug: null
  uri: null
  parentId: null
  position: null
  values: AuthorsValues
}

export type PagesValues = {
  heading: string
  seo?: GroupSeo
  meta?: GroupMeta
  items?: Array<{
    share?: GroupOg
  }>
}

export type PagesResolvedValues<Depth extends number> = {
  seo?: GroupSeoResolved<Depth>
  items?: Array<{
    share?: GroupOgResolved<Depth>
  }>
}

export type EntryPages = Omit<Entry, 'type' | 'slug' | 'uri' | 'parentId' | 'position' | 'values'> & {
  type: "pages"
  slug: null
  uri: null
  parentId: null
  position: null
  values: PagesValues
}

export type ContactFormValues = {
  name: string
  email: string
  topics?: Array<"sales" | "support">
  size?: number
  subscribe?: boolean
  address?: {
    town: string
  }
  source?: "website"
  guests?: Array<{
    guest?: string
  }>
}

declare module '@iight/sdk' {
  interface EntryTypes {
    blog: EntryBlog
    docs: EntryDocs
    home: EntryHome
    authors: EntryAuthors
    pages: EntryPages
  }
  interface ResolvedTypes<Depth extends number> {
    blog: BlogResolvedValues<Depth>
    docs: DocsResolvedValues<Depth>
    home: HomeResolvedValues<Depth>
    authors: AuthorsResolvedValues<Depth>
    pages: PagesResolvedValues<Depth>
  }
  interface FormTypes {
    contact: ContactFormValues
  }
  interface DeliverySettings {
    depth: 2
  }
}
