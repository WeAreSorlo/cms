export interface Config {
  database: {
    // A Postgres connection string
    url: string
  }
}

// Types a site project's iight.config.ts
export const defineConfig = (config: Config) => config

// Types a site project's content migrations
export type { ContentMigration, EntryChanges } from './content'
