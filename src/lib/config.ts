import { eq } from 'drizzle-orm'

import type { AppDatabase } from './db'
import { config } from './schema'

/**
 * Config knobs (spec 0001 AC-8). Seeded by migration 0000; `ensureConfig`
 * covers first use on a database that predates the seed.
 */
const CONFIG_DEFAULTS = {
  follow_up_hours: '5',
  reply_retention_days: '20',
  listing_retention_days: '25',
} as const

export type ConfigKey = keyof typeof CONFIG_DEFAULTS
export type ConfigValues = Record<ConfigKey, number>

const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS) as ConfigKey[]

export function isConfigKey(key: string): key is ConfigKey {
  return key in CONFIG_DEFAULTS
}

/** Documented default for a knob, as a number. */
export function fallbackConfigValue(key: ConfigKey): number {
  return Number.parseInt(CONFIG_DEFAULTS[key], 10)
}

function toPositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Idempotently seeds the config table. Called on read paths, so rows always
 * exist before they are consumed.
 */
export async function ensureConfig(db: AppDatabase): Promise<void> {
  await db
    .insert(config)
    .values(
      CONFIG_KEYS.map((key) => ({ key, value: CONFIG_DEFAULTS[key] })),
    )
    .onConflictDoNothing()
}

/**
 * Reads known config keys as numbers: a one key overload and an all keys
 * overload. A missing row is seeded first; a malformed value falls back to the
 * documented default rather than returning garbage.
 */
export async function getConfigValues(db: AppDatabase, key: ConfigKey): Promise<number>
export async function getConfigValues(db: AppDatabase): Promise<ConfigValues>
export async function getConfigValues(db: AppDatabase, key?: ConfigKey): Promise<number | ConfigValues> {
  await ensureConfig(db)

  if (key !== undefined) {
    const [row] = await db.select().from(config).where(eq(config.key, key)).limit(1)
    return row && row.value !== null
      ? toPositiveInt(row.value, fallbackConfigValue(key))
      : fallbackConfigValue(key)
  }

  const rows = await db.select().from(config)
  const result = {} as ConfigValues
  for (const key of CONFIG_KEYS) {
    const row = rows.find((r) => r.key === key && typeof r.value === 'string')
    result[key] =
      row !== undefined && row.value !== null
        ? toPositiveInt(row.value, fallbackConfigValue(key))
        : fallbackConfigValue(key)
  }
  return result
}
