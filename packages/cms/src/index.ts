import type { DriveManagerOptions, DriverContract } from 'flydrive/types'

export interface Config {
  database: {
    // A Postgres connection string
    url: string
  }
  // Where uploaded media is stored: FlyDrive's DriveManager options, whose services are the disks
  storage: Storage
  media?: MediaOptions
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

// Every format of image, video and audio that a file's content can show, and PDFs
export const defaultMediaTypes = ['image/*', 'video/*', 'audio/*', 'application/pdf']

// Types a site project's iight.config.ts
export const defineConfig = (config: Config) => config

// Types a site project's content migrations
export type { ContentMigration, EntryChanges } from './content'
