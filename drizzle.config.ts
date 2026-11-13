import { defineConfig } from 'drizzle-kit'

// Generated SQL lands where wrangler d1 migrations expects it (migrations/),
// so `wrangler d1 migrations apply` works unchanged.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/schema.ts',
  out: './migrations',
})
