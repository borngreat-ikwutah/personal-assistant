import { describe, expect, test } from 'bun:test'

import {
  FreehireIngestionError,
  ingestFreehireListings,
} from '../src/lib/freehire-ingestion-client'

const observation = {
  freehireId: 'job-123',
  url: 'https://jobs.example.com/job-123',
  title: 'Backend Engineer',
}

const config = {
  apiUrl: 'https://agent.example.com/base',
  apiSecret: 'worker-secret',
}

describe('Freehire listing ingestion client', () => {
  test('sends normalized listings to the authenticated internal route', async () => {
    let request: Request | undefined
    const fetcher: typeof fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        ok: true,
        inserted: 1,
        updated: 0,
        items: [{ id: 7, freehireId: 'job-123', status: 'new' }],
      })
    }

    const result = await ingestFreehireListings([observation], config, fetcher)

    expect(request?.url).toBe('https://agent.example.com/internal/freehire/listings')
    expect(request?.method).toBe('POST')
    expect(request?.redirect).toBe('error')
    expect(request?.headers.get('API_SECRET')).toBe('worker-secret')
    expect(await request?.json()).toEqual({ listings: [observation] })
    expect(result.inserted).toBe(1)
  })

  test('rejects insecure API URLs before making a request', async () => {
    let called = false
    const fetcher: typeof fetch = async () => {
      called = true
      return Response.json({})
    }

    await expect(
      ingestFreehireListings([observation], { ...config, apiUrl: 'http://agent.example.com' }, fetcher),
    ).rejects.toBeInstanceOf(FreehireIngestionError)
    expect(called).toBe(false)
  })

  test('does not include an upstream error body in its error', async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ error: 'secret provider response' }, { status: 500 })

    await expect(ingestFreehireListings([observation], config, fetcher)).rejects.toThrow(
      'failed with status 500',
    )
    await expect(ingestFreehireListings([observation], config, fetcher)).rejects.not.toThrow(
      'secret provider response',
    )
  })

  test('rejects malformed success responses', async () => {
    const fetcher: typeof fetch = async () => Response.json({ ok: true, inserted: '1' })

    await expect(ingestFreehireListings([observation], config, fetcher)).rejects.toThrow(
      'invalid response',
    )
  })

  test('retries transient Worker failures but not authentication failures', async () => {
    const unauthorized: typeof fetch = async () => new Response(null, { status: 401 })
    const unavailable: typeof fetch = async () => new Response(null, { status: 503 })

    await expect(ingestFreehireListings([observation], config, unauthorized)).rejects.toMatchObject({
      retryable: false,
    })
    await expect(ingestFreehireListings([observation], config, unavailable)).rejects.toMatchObject({
      retryable: true,
    })
  })

  test('chunks fifty-result searches below the D1 query budget', async () => {
    const batchSizes: number[] = []
    let nextId = 1
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const body = (await request.json()) as { listings: typeof observation[] }
      batchSizes.push(body.listings.length)
      return Response.json({
        ok: true,
        inserted: body.listings.length,
        updated: 0,
        items: body.listings.map((listing) => ({
          id: nextId++,
          freehireId: listing.freehireId,
          status: 'new',
        })),
      })
    }
    const observations = Array.from({ length: 50 }, (_, index) => ({
      ...observation,
      freehireId: `job-${index}`,
    }))

    const result = await ingestFreehireListings(observations, config, fetcher)

    expect(batchSizes).toEqual([10, 10, 10, 10, 10])
    expect(result.inserted).toBe(50)
    expect(result.items).toHaveLength(50)
  })
})
