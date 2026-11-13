import { describe, expect, test } from 'bun:test'

import {
  FreehireMcpError,
  classifyFreehireToolError,
  discoverFreehireTools,
  normalizeFreehireJob,
  parseFreehireSearchResult,
  parseFreehireToolResult,
} from '../src/lib/freehire-mcp'

const textResult = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
})

describe('Freehire MCP response boundary', () => {
  test('parses JSON text and rejects non-JSON success payloads', () => {
    expect(parseFreehireToolResult(textResult({ ok: true }))).toEqual({ ok: true })
    expect(() =>
      parseFreehireToolResult({ content: [{ type: 'text', text: 'not json' }] }),
    ).toThrow('invalid JSON')
  })

  test('classifies non-retryable authentication and input failures', () => {
    const auth = classifyFreehireToolError('api error 401: invalid token')
    const input = classifyFreehireToolError('Input validation error: Invalid arguments for tool search')

    expect(auth).toMatchObject({ code: 'authentication', retryable: false })
    expect(input).toMatchObject({ code: 'invalid-input', retryable: false })
  })

  test('classifies bounded retry failures without retaining provider text', () => {
    const rateLimit = classifyFreehireToolError('api error 429: private provider detail')
    const timeout = classifyFreehireToolError('MCP error -32001: Request timed out')

    expect(rateLimit).toMatchObject({ code: 'rate-limit', retryable: true })
    expect(rateLimit.message).not.toContain('private provider detail')
    expect(timeout).toMatchObject({ code: 'timeout', retryable: true })
  })

  test('turns tool error results into typed errors', () => {
    expect(() =>
      parseFreehireToolResult({
        content: [{ type: 'text', text: 'not authenticated: set FREEHIRE_TOKEN' }],
        isError: true,
      }),
    ).toThrow(FreehireMcpError)
  })
})

describe('Freehire job normalization', () => {
  test('maps provider fields to the local listing contract', () => {
    expect(
      normalizeFreehireJob({
        public_slug: 'backend-engineer-acme',
        title: ' Backend Engineer ',
        company: { name: 'Acme' },
        description_markdown: '# Build services',
        posting_url: 'https://jobs.example.com/backend#apply',
        location: { display_name: 'Remote, EU' },
        published_at: '2026-11-01T10:30:00+00:00',
      }),
    ).toEqual({
      freehireId: 'backend-engineer-acme',
      title: 'Backend Engineer',
      company: 'Acme',
      description: '# Build services',
      url: 'https://jobs.example.com/backend',
      location: 'Remote, EU',
      postedAt: '2026-11-01T10:30:00.000Z',
    })
  })

  test('fails closed when a search hit has no public slug', () => {
    expect(() => normalizeFreehireJob({ title: 'No identity' })).toThrow('public slug')
  })

  test('deduplicates search hits and sanitizes ignored values', () => {
    const result = parseFreehireSearchResult({
      data: [
        { public_slug: 'job-1', title: 'First' },
        { public_slug: 'job-1', title: 'Duplicate' },
      ],
      total: 2,
      ignored: [{ param: 'countries', did_you_mean: 'country' }],
      ignored_values: { skills: ['golangg'] },
    })

    expect(result.jobs).toHaveLength(1)
    expect(result.ignored).toEqual([{ name: 'countries', suggestion: 'country' }])
    expect(result.ignoredValues).toEqual({ skills: ['golangg'] })
  })
})

describe('Freehire local MCP lifecycle', () => {
  test('starts the pinned stdio server and discovers required tools', async () => {
    const tools = await discoverFreehireTools({ token: 'test-only-not-used', timeoutMs: 10_000 })

    expect(tools).toEqual(expect.arrayContaining(['facets', 'search', 'job', 'save', 'apply', 'stage']))
  }, 15_000)
})
