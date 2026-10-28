import type { DriveManagerOptions, DriverContract } from 'flydrive/types'

export interface Config {
  database: {
    // A Postgres connection string
    url: string
  }
  // Where uploaded media is stored: FlyDrive's DriveManager options, whose services are the disks
  storage: Storage
  media?: MediaOptions
  delivery?: DeliveryOptions
}

export type Storage = DriveManagerOptions<Record<string, () => DriverContract>>

// What the media library takes, and how it serves files
export interface MediaOptions {
  // MIME types, checked against each file's content, with wildcards such as image/*. Defaults to defaultMediaTypes.
  types?: Array<string>
  // The largest file in bytes, 50 MB if not given. Each upload is held in memory while it's checked.
  maxFileSize?: number
  // The Cache-Control header of served files, public, max-age=3600 if not given
  cacheControl?: string
}

// How deep the delivery API's with resolves links: the fields it names are the first level, and the links of what they
// hold are the next
export interface DeliveryOptions {
  // The levels a request gets when it doesn't send depth, 2 if not given
  depth?: number
  // The most levels a request can ask for, 5 if not given. Each level can multiply the entries a reply holds.
  maxDepth?: number
}

// Every format of image, video and audio that a file's content can show, and PDFs
export const defaultMediaTypes = ['image/*', 'video/*', 'audio/*', 'application/pdf']

// Types a site project's iight.config.ts
export const defineConfig = (config: Config) => config

// Types a site project's content migrations
export type { ContentMigration, EntryChanges } from './content'
