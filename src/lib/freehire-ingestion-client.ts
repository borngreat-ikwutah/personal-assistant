import { z } from 'zod'

import type { FreehireListingObservation } from './freehire-listings'

const INGESTION_CHUNK_SIZE = 10

const ingestionResponseSchema = z
  .object({
    ok: z.literal(true),
    inserted: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        id: z.number().int().positive(),
        freehireId: z.string().min(1),
        status: z.enum(['new', 'suggested', 'skipped', 'applied']),
      }),
    ),
  })
  .strict()

export type FreehireIngestionResult = z.infer<typeof ingestionResponseSchema>

export type FreehireIngestionConfig = {
  apiUrl: string
  apiSecret: string
  timeoutMs?: number
}

export class FreehireIngestionError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'FreehireIngestionError'
  }
}

const ingestionEndpoint = (apiUrl: string): URL => {
  let base: URL
  try {
    base = new URL(apiUrl)
  } catch {
    throw new FreehireIngestionError('Job agent API URL is invalid')
  }
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new FreehireIngestionError('Job agent API URL must be a credential-free HTTPS URL')
  }
  return new URL('/internal/freehire/listings', base)
}

export async function ingestFreehireListings(
  observations: readonly FreehireListingObservation[],
  config: FreehireIngestionConfig,
  fetcher: typeof fetch = fetch,
): Promise<FreehireIngestionResult> {
  if (!config.apiSecret) throw new FreehireIngestionError('Job agent API secret is missing')
  if (observations.length < 1 || observations.length > 50) {
    throw new FreehireIngestionError('Freehire ingestion batch must contain 1 to 50 listings')
  }

  const timeoutMs = config.timeoutMs ?? 15_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new FreehireIngestionError('Job agent API timeout is invalid')
  }

  const result: FreehireIngestionResult = { ok: true, inserted: 0, updated: 0, items: [] }
  for (let offset = 0; offset < observations.length; offset += INGESTION_CHUNK_SIZE) {
    const chunk = observations.slice(offset, offset + INGESTION_CHUNK_SIZE)
    const response = await ingestFreehireListingChunk(chunk, config, timeoutMs, fetcher)
    result.inserted += response.inserted
    result.updated += response.updated
    result.items.push(...response.items)
  }
  return result
}

const ingestFreehireListingChunk = async (
  observations: readonly FreehireListingObservation[],
  config: FreehireIngestionConfig,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<FreehireIngestionResult> => {

  let response: Response
  try {
    response = await fetcher(ingestionEndpoint(config.apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        API_SECRET: config.apiSecret,
      },
      body: JSON.stringify({ listings: observations }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
  } catch {
    throw new FreehireIngestionError('Job agent listing ingestion request failed', true)
  }

  if (!response.ok) {
    const retryable =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    throw new FreehireIngestionError(
      `Job agent listing ingestion failed with status ${response.status}`,
      retryable,
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new FreehireIngestionError('Job agent listing ingestion returned invalid JSON')
  }

  const parsed = ingestionResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new FreehireIngestionError('Job agent listing ingestion returned an invalid response')
  }
  return parsed.data
}
