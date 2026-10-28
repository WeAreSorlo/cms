// Generated from the CMS by `npx iight types pull`. Pull again rather than editing it.

import type { Linked, Media } from '@iight/sdk'

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

export type DocsResolvedValues<Depth extends number> = {}

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

export type HomeResolvedValues<Depth extends number> = {}

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

export type AuthorsValues = {
  name: string
  avatar?: string
}

export type AuthorsResolvedValues<Depth extends number> = {
  avatar?: Media | null
}

export type EntryAuthors = {
  id: string
  type: "authors"
  slug: null
  uri: null
  parentId: null
  position: null
  values: AuthorsValues
  createdAt: string
  updatedAt: string
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
  }
  interface ResolvedTypes<Depth extends number> {
    blog: BlogResolvedValues<Depth>
    docs: DocsResolvedValues<Depth>
    home: HomeResolvedValues<Depth>
    authors: AuthorsResolvedValues<Depth>
  }
  interface FormTypes {
    contact: ContactFormValues
  }
  interface DeliverySettings {
    depth: 2
  }
}
