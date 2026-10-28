export interface Config {
  database: {
    // A Postgres connection string
    url: string
  }
}

// Types a site project's iight.config.ts
export const defineConfig = (config: Config) => config
