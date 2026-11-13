import { AbortTaskRunError, schemaTask } from '@trigger.dev/sdk'
import { z } from 'zod'

import {
  FreehireMcpError,
  freehireFiltersSchema,
  freehireSkillsSchema,
  getFreehireJob,
  searchFreehire,
  trackFreehireJob,
} from '../lib/freehire-mcp'
import { FreehireIngestionError, ingestFreehireListings } from '../lib/freehire-ingestion-client'

interface TriggerNodeEnv {
  process?: { env?: Record<string, string | undefined> }
}

const getEnv = (): Record<string, string | undefined> =>
  (globalThis as TriggerNodeEnv).process?.env ?? {}

const getMcpConfig = () => {
  const env = getEnv()
  const token = env.FREEHIRE_TOKEN
  if (!token) throw new AbortTaskRunError('Freehire authentication is not configured')

  const timeoutMs = Number(env.FREEHIRE_OPERATION_TIMEOUT_MS ?? 30_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new AbortTaskRunError('Freehire operation timeout is invalid')
  }
  return { token, timeoutMs }
}

const getIngestionConfig = () => {
  const env = getEnv()
  const apiUrl = env.JOB_AGENT_API_URL
  const apiSecret = env.JOB_AGENT_API_SECRET
  if (!apiUrl || !apiSecret) {
    throw new AbortTaskRunError('Job agent listing ingestion is not configured')
  }
  return { apiUrl, apiSecret }
}

const runProviderOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (
      (error instanceof FreehireMcpError || error instanceof FreehireIngestionError) &&
      !error.retryable
    ) {
      throw new AbortTaskRunError(error.message)
    }
    throw error
  }
}

const taskRetry = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 10_000,
  randomize: true,
} as const

const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(50).default(10),
    skills: freehireSkillsSchema.optional(),
    filters: freehireFiltersSchema.default({}),
  })
  .strict()

export const searchFreehireTask = schemaTask({
  id: 'search-freehire',
  schema: searchSchema,
  maxDuration: 180,
  retry: taskRetry,
  queue: { concurrencyLimit: 2 },
  run: async (payload) =>
    runProviderOperation(async () => {
      const search = await searchFreehire(getMcpConfig(), payload)
      const hasProviderWarnings =
        search.ignored.length > 0 || Object.keys(search.ignoredValues).length > 0
      const persistence =
        search.jobs.length > 0 && !hasProviderWarnings
          ? await ingestFreehireListings(search.jobs, getIngestionConfig())
          : { inserted: 0, updated: 0, items: [] }

      return {
        query: payload.query,
        total: search.total,
        ignored: search.ignored,
        ignoredValues: search.ignoredValues,
        jobs: search.jobs.map(({ description: _description, ...job }) => job),
        inserted: persistence.inserted,
        updated: persistence.updated,
        persistenceSkipped: hasProviderWarnings,
      }
    }),
})

const jobSchema = z.object({ slug: z.string().trim().min(1).max(200) }).strict()

export const getFreehireJobTask = schemaTask({
  id: 'get-freehire-job',
  schema: jobSchema,
  maxDuration: 120,
  retry: taskRetry,
  queue: { concurrencyLimit: 2 },
  run: async ({ slug }) =>
    runProviderOperation(async () => {
      const job = await getFreehireJob(getMcpConfig(), slug)
      const persistence = await ingestFreehireListings([job], getIngestionConfig())
      return {
        job,
        inserted: persistence.inserted,
        updated: persistence.updated,
      }
    }),
})

const stageSchema = z.enum([
  'applied',
  'screening',
  'responded',
  'interview',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
])

const trackingSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('save'), slug: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({ operation: z.literal('mark_applied'), slug: z.string().trim().min(1).max(200) })
    .strict(),
  z
    .object({
      operation: z.literal('stage'),
      slug: z.string().trim().min(1).max(200),
      stage: stageSchema,
    })
    .strict(),
])

export const trackFreehireJobTask = schemaTask({
  id: 'track-freehire-job',
  schema: trackingSchema,
  maxDuration: 120,
  retry: taskRetry,
  queue: { concurrencyLimit: 1 },
  run: async (payload) =>
    runProviderOperation(async () => {
      await trackFreehireJob(getMcpConfig(), payload)
      return {
        slug: payload.slug,
        operation: payload.operation,
        ...(payload.operation === 'stage' ? { stage: payload.stage } : {}),
        providerTrackingOnly: true as const,
      }
    }),
})
