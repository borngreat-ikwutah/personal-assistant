import { describe, expect, test } from 'bun:test'

import {
  MAX_BROWSER_APPROVAL_TTL_MS,
  assertPublicIpAddress,
  canonicalizeAllowedBrowserHost,
  canonicalizePublicHttpsUrl,
  createBrowserApprovalSignature,
  createBrowserManifestDigest,
  verifyBrowserApprovalReceipt,
} from '../src/lib/browser-security'
import {
  createBrowserAutomationApprovalBundle,
  openBrowserAutomationPlan,
  sealBrowserAutomationPlan,
} from '../src/lib/browser-plan'

describe('browser target validation', () => {
  test('canonicalizes a public HTTPS target', () => {
    const target = canonicalizePublicHttpsUrl('https://EXAMPLE.com.:443/jobs/../apply?source=agent#form')

    expect(target.canonicalUrl).toBe('https://example.com/apply?source=agent')
    expect(target.hostname).toBe('example.com')
  })

  test.each([
    'http://example.com/apply',
    'https://example.com:8443/apply',
    'https://user:password@example.com/apply',
    'https://localhost/apply',
    'https://jobs.local/apply',
    'https://127.0.0.1/apply',
    'https://127.1/apply',
    'https://10.20.30.40/apply',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.10/apply',
    'https://198.51.100.20/apply',
    'https://93.184.216.34/apply',
    'https://[::1]/apply',
    'https://[::ffff:127.0.0.1]/apply',
    'https://[fc00::1]/apply',
    'https://[fe80::1]/apply',
    'https://[2001:db8::1]/apply',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/apply',
  ])('rejects non-public target %s', (value) => {
    expect(() => canonicalizePublicHttpsUrl(value)).toThrow()
  })

  test('accepts exact public allowed hosts and rejects wildcards or ports', () => {
    expect(canonicalizeAllowedBrowserHost('APPLY.example.com.')).toBe('apply.example.com')
    expect(() => canonicalizeAllowedBrowserHost('*.example.com')).toThrow()
    expect(() => canonicalizeAllowedBrowserHost('example.com:8443')).toThrow()
    expect(() => canonicalizeAllowedBrowserHost('jobs.local')).toThrow()
  })

  test('rejects reserved DNS answers before Chromium starts', () => {
    expect(() => assertPublicIpAddress('93.184.216.34')).not.toThrow()
    expect(() => assertPublicIpAddress('10.0.0.1')).toThrow()
    expect(() => assertPublicIpAddress('::1')).toThrow()
  })
})

describe('browser submission approval receipts', () => {
  const secret = 's'.repeat(32)
  const now = 1_800_000_000_000
  const expiresAt = now + 60_000
  const input = {
    applicationId: 'application-123',
    targetUrl: 'https://EXAMPLE.com:443/jobs/../apply?role=engineer#form',
    manifestDigest: 'a'.repeat(64),
    nonce: 'approval_nonce_12345',
    issuedAt: now - 1_000,
    expiresAt,
  }

  test('accepts a valid receipt for the canonical target', async () => {
    const signature = await createBrowserApprovalSignature(input, secret)

    expect(
      await verifyBrowserApprovalReceipt(
        {
          ...input,
          targetUrl: 'https://example.com/apply?role=engineer',
          signature,
        },
        secret,
        now,
      ),
    ).toBe(true)
  })

  test('rejects changed application IDs, targets, signatures, and secrets', async () => {
    const signature = await createBrowserApprovalSignature(input, secret)
    const receipt = { ...input, signature }
    const changedSignature = `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`

    expect(
      await verifyBrowserApprovalReceipt({ ...receipt, applicationId: 'application-456' }, secret, now),
    ).toBe(false)
    expect(
      await verifyBrowserApprovalReceipt(
        { ...receipt, targetUrl: 'https://example.com/apply?role=manager' },
        secret,
        now,
      ),
    ).toBe(false)
    expect(await verifyBrowserApprovalReceipt({ ...receipt, signature: changedSignature }, secret, now)).toBe(
      false,
    )
    expect(await verifyBrowserApprovalReceipt(receipt, 'x'.repeat(32), now)).toBe(false)
    expect(
      await verifyBrowserApprovalReceipt({ ...receipt, manifestDigest: 'b'.repeat(64) }, secret, now),
    ).toBe(false)
  })

  test('rejects expired and non-short-lived receipts', async () => {
    const expiredInput = { ...input, expiresAt: now }
    const expiredSignature = await createBrowserApprovalSignature(expiredInput, secret)
    expect(
      await verifyBrowserApprovalReceipt({ ...expiredInput, signature: expiredSignature }, secret, now),
    ).toBe(false)

    const distantInput = { ...input, expiresAt: now + MAX_BROWSER_APPROVAL_TTL_MS + 1 }
    await expect(createBrowserApprovalSignature(distantInput, secret)).rejects.toThrow(
      'Approval receipt is invalid',
    )
  })
})

describe('sealed browser plans', () => {
  const secret = 'p'.repeat(32)
  const context = { applicationId: 'application-123', targetUrl: 'https://example.com/apply' }
  const plan = {
    actions: [{ type: 'fill' as const, selector: '#email', value: 'private@example.com' }],
    finalSubmit: {
      selector: '#submit',
      confirmationSelector: '#application-received',
      request: { method: 'POST' as const, url: 'https://example.com/apply' },
    },
  }

  test('encrypts sensitive actions and binds them to application context', async () => {
    const sealed = await sealBrowserAutomationPlan(plan, context, secret)

    expect(sealed).not.toContain('private@example.com')
    expect(await openBrowserAutomationPlan(sealed, context, secret)).toEqual(plan)
    await expect(
      openBrowserAutomationPlan(sealed, { ...context, applicationId: 'application-456' }, secret),
    ).rejects.toThrow('could not be opened')
  })

  test('creates the same digest for equivalent manifest key order', async () => {
    const left = await createBrowserManifestDigest({ applicationId: '1', plan, allowedHosts: ['a.com'] })
    const right = await createBrowserManifestDigest({ plan, allowedHosts: ['a.com'], applicationId: '1' })

    expect(left).toBe(right)
  })

  test('builds an encrypted task payload with a valid signed manifest', async () => {
    const now = 1_800_000_000_000
    const bundle = await createBrowserAutomationApprovalBundle(
      {
        ...context,
        allowedHosts: ['assets.example.com'],
        plan,
        nonce: 'approval_nonce_12345',
        issuedAt: now - 1_000,
        expiresAt: now + 60_000,
      },
      secret,
    )

    expect(bundle.sealedPlan).not.toContain('private@example.com')
    expect(bundle.allowedHosts).toEqual(['assets.example.com'])
    expect(
      await verifyBrowserApprovalReceipt(
        {
          applicationId: bundle.applicationId,
          targetUrl: bundle.targetUrl,
          ...bundle.approval,
        },
        secret,
        now,
      ),
    ).toBe(true)
  })
})
