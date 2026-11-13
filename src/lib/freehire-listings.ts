import { inArray, sql } from 'drizzle-orm'

import { nowIso, type AppDatabase } from './db'
import { listings } from './schema'

export type FreehireListingObservation = {
  freehireId: string
  url?: string | null
  title?: string | null
  company?: string | null
  description?: string | null
  postedAt?: string | null
  location?: string | null
}

export async function upsertFreehireListings(
  db: AppDatabase,
  observations: readonly FreehireListingObservation[],
) {
  if (observations.length === 0) {
    return { inserted: 0, updated: 0, items: [] }
  }

  const freehireIds = observations.map(({ freehireId }) => freehireId)
  const existing = await db
    .select({ freehireId: listings.freehireId })
    .from(listings)
    .where(inArray(listings.freehireId, freehireIds))
  const existingIds = new Set(existing.map(({ freehireId }) => freehireId))
  const observedAt = nowIso()

  const items = await db
    .insert(listings)
    .values(
      observations.map((observation) => ({
        freehireId: observation.freehireId,
        url: observation.url,
        title: observation.title,
        company: observation.company,
        description: observation.description,
        postedAt: observation.postedAt,
        location: observation.location,
        firstSeenAt: observedAt,
        updatedAt: observedAt,
      })),
    )
    .onConflictDoUpdate({
      target: listings.freehireId,
      set: {
        url: sql`coalesce(excluded.url, ${listings.url})`,
        title: sql`coalesce(excluded.title, ${listings.title})`,
        company: sql`coalesce(excluded.company, ${listings.company})`,
        description: sql`coalesce(excluded.description, ${listings.description})`,
        postedAt: sql`coalesce(excluded.posted_at, ${listings.postedAt})`,
        location: sql`coalesce(excluded.location, ${listings.location})`,
        updatedAt: observedAt,
      },
    })
    .returning({
      id: listings.id,
      freehireId: listings.freehireId,
      status: listings.status,
    })

  const updated = observations.reduce(
    (count, observation) => count + Number(existingIds.has(observation.freehireId)),
    0,
  )
  return { inserted: observations.length - updated, updated, items }
}
