import { describe, expect, test } from 'bun:test'

import {
  BrowserApprovalConsumptionError,
  consumeRemoteBrowserApproval,
} from '../src/lib/browser-approvals'

const approval = {
  applicationId: 'application-123',
  manifestDigest: 'a'.repeat(64),
  nonce: 'approval_nonce_12345',
  issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_060_000,
}

const config = {
  apiUrl: 'https://agent.example.com',
  apiSecret: 'worker-secret',
}

describe('remote browser approval consumption', () => {
  test('uses a redirect-safe authenticated request', async () => {
    let request: Request | undefined
    const fetcher: typeof fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({ ok: true }, { status: 201 })
    }

    await consumeRemoteBrowserApproval(approval, config, fetcher)

    expect(request?.url).toBe('https://agent.example.com/internal/browser-approvals/consume')
    expect(request?.headers.get('API_SECRET')).toBe('worker-secret')
    expect(request?.redirect).toBe('error')
    expect(await request?.json()).toEqual(approval)
  })

  test('rejects replay without retrying it', async () => {
    const fetcher: typeof fetch = async () => new Response(null, { status: 409 })

    await expect(consumeRemoteBrowserApproval(approval, config, fetcher)).rejects.toMatchObject({
      name: 'BrowserApprovalConsumptionError',
      retryable: false,
    })
  })

  test('marks transient Worker failures retryable', async () => {
    const fetcher: typeof fetch = async () => new Response(null, { status: 503 })

    await expect(consumeRemoteBrowserApproval(approval, config, fetcher)).rejects.toBeInstanceOf(
      BrowserApprovalConsumptionError,
    )
    await expect(consumeRemoteBrowserApproval(approval, config, fetcher)).rejects.toMatchObject({
      retryable: true,
    })
  })
})
