import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * D1 application data model — the decided schema lives in
 * docs/specs/0001-d1-application-data-model.md. Timestamps are stored as
 * ISO-8601 text; `updated_at` is maintained in code (see src/lib/db.ts).
 */

export const listings = sqliteTable(
  'listings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    freehireId: text('freehire_id').notNull().unique(),
    url: text('url'),
    title: text('title'),
    company: text('company'),
    description: text('description'),
    postedAt: text('posted_at'),
    location: text('location'),
    status: text('status', {
      enum: ['new', 'suggested', 'skipped', 'applied'],
    })
      .notNull()
      .default('new'),
    firstSeenAt: text('first_seen_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [check('listings_status_check', sql`${t.status} IN ('new','suggested','skipped','applied')`)],
)

export const APPLICATION_STATUSES = [
  'suggested',
  'approved',
  'submitted',
  'replied',
  'handled',
  'skipped',
  'failed',
] as const

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

/** Frozen payload bag: cover note, cv_version_id, submitted body, attempts. */
export type ApplicationPayload = Record<string, unknown>

export const applications = sqliteTable(
  'applications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: integer('listing_id')
      .notNull()
      .unique()
      .references(() => listings.id),
    status: text('status', { enum: APPLICATION_STATUSES }).notNull(),
    matchScore: real('match_score'),
    matchReason: text('match_reason'),
    matchedAt: text('matched_at'),
    payload: text('payload', { mode: 'json' }).$type<ApplicationPayload>(),
    telegramMessageId: text('telegram_message_id'),
    followUpAt: text('follow_up_at'),
    followedUpAt: text('followed_up_at'),
    lastSubmittedAt: text('last_submitted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('applications_status_check', sql`${t.status} IN ('suggested','approved','submitted','replied','handled','skipped','failed')`),
    index('applications_status_follow_up_at_idx').on(t.status, t.followUpAt),
  ],
)

export const replies = sqliteTable('replies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  applicationId: integer('application_id').references(() => applications.id),
  emailMessageId: text('email_message_id').notNull().unique(),
  fromAddr: text('from_addr'),
  subject: text('subject'),
  snippet: text('snippet'),
  rawRef: text('raw_ref'),
  receivedAt: text('received_at').notNull(),
  alertedAt: text('alerted_at'),
  createdAt: text('created_at').notNull(),
})

export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value'),
})

export const cvDocuments = sqliteTable('cv_documents', {
  id: text('id').primaryKey(),
  currentVersionId: integer('current_version_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const cvVersions = sqliteTable(
  'cv_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: text('document_id')
      .notNull()
      .references(() => cvDocuments.id),
    objectKey: text('object_key').notNull().unique(),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [check('cv_versions_size_check', sql`${t.sizeBytes} BETWEEN 1 AND 10485760`)],
)

export type Listing = typeof listings.$inferSelect
export type NewListing = typeof listings.$inferInsert
export type Application = typeof applications.$inferSelect
export type NewApplication = typeof applications.$inferInsert
export type Reply = typeof replies.$inferSelect
export type ConfigRow = typeof config.$inferSelect
export type CvDocument = typeof cvDocuments.$inferSelect
export type CvVersion = typeof cvVersions.$inferSelect
