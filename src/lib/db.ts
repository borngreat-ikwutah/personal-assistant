import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'

import * as schema from './schema'

/**
 * Typed drizzle client over the `DB` D1 binding (spec 0001 AC-2).
 * Importable from route handlers and from Trigger.dev tasks; the binding
 * arrives as an argument so the module itself never depends on a runtime.
 */
export type AppDatabase = DrizzleD1Database<typeof schema>

export function createDb(binding: D1Database): AppDatabase {
  return drizzle(binding, { schema })
}

/** Canonical timestamp shape for created_at / updated_at columns. */
export function nowIso(): string {
  return new Date().toISOString()
}
