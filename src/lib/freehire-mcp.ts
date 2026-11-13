import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const FREEHIRE_API_URL = 'https://freehire.me'

interface NodeRuntime {
  process?: {
    execPath?: string
    cwd?: () => string
  }
}

const freehireProcess = () => {
  const runtime = (globalThis as NodeRuntime).process
  const cwd = runtime?.cwd?.()
  if (!runtime?.execPath || !cwd) {
    throw new FreehireMcpError('provider', true, 'Freehire MCP runtime is unavailable')
  }
  return {
    command: runtime.execPath,
    serverEntry: `${cwd.replace(/\/$/, '')}/node_modules/freehire-mcp/dist/index.js`,
  }
}

const textListSchema = z.array(z.string().trim().min(1).max(200)).max(50)
const genericFacetsSchema = z
  .record(
    z.string().trim().min(1).max(100),
    z.union([z.string().trim().min(1).max(200), textListSchema]),
  )
  .superRefine((value, context) => {
    if (Object.keys(value).length > 25) {
      context.addIssue({ code: 'custom', message: 'too many generic facet filters' })
    }
  })

export const freehireFiltersSchema = z
  .object({
    remote: z.boolean().optional(),
    region: textListSchema.optional(),
    country: textListSchema.optional(),
    city: textListSchema.optional(),
    company: textListSchema.optional(),
    category: textListSchema.optional(),
    role: textListSchema.optional(),
    seniority: textListSchema.optional(),
    employment_type: textListSchema.optional(),
    english_level: textListSchema.optional(),
    exclude_skill: textListSchema.optional(),
    salary_min: z.number().int().nonnegative().max(10_000_000).optional(),
    visa: z.boolean().optional(),
    facets: genericFacetsSchema.optional(),
  })
  .strict()

export type FreehireFilters = z.infer<typeof freehireFiltersSchema>
export const freehireSkillsSchema = textListSchema

export type FreehireJob = {
  freehireId: string
  title: string | null
  company: string | null
  description: string | null
  url: string | null
  location: string | null
  postedAt: string | null
}

export type FreehireSearchResult = {
  jobs: FreehireJob[]
  total: number
  ignored: Array<{ name: string; suggestion?: string }>
  ignoredValues: Record<string, string[]>
}

export type FreehireErrorCode =
  | 'authentication'
  | 'invalid-input'
  | 'rate-limit'
  | 'timeout'
  | 'provider'
  | 'malformed-response'
  | 'missing-tool'

export class FreehireMcpError extends Error {
  constructor(
    public readonly code: FreehireErrorCode,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'FreehireMcpError'
  }
}

type FreehireMcpConfig = {
  token: string
  timeoutMs: number
}

type ToolResult = {
  content?: unknown
  isError?: boolean
}

type FreehireMcpSession = {
  tools: ReadonlySet<string>
  callJson: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() }).passthrough()
const rawJobSchema = z.record(z.string(), z.unknown())
const searchPageSchema = z
  .object({
    data: z.array(rawJobSchema).max(100),
    total: z.number().int().nonnegative(),
    ignored: z.unknown().optional(),
    ignored_values: z.unknown().optional(),
  })
  .passthrough()

const toolText = (result: ToolResult): string => {
  if (!Array.isArray(result.content)) {
    throw new FreehireMcpError('malformed-response', false, 'Freehire returned a malformed response')
  }
  const blocks = result.content.flatMap((block) => {
    const parsed = textBlockSchema.safeParse(block)
    return parsed.success ? [parsed.data.text] : []
  })
  if (blocks.length === 0) {
    throw new FreehireMcpError('malformed-response', false, 'Freehire returned a malformed response')
  }
  return blocks.join('\n')
}

export function classifyFreehireToolError(value: string): FreehireMcpError {
  if (/not authenticated|api error 401|api error 403/i.test(value)) {
    return new FreehireMcpError('authentication', false, 'Freehire authentication failed')
  }
  if (
    /input validation error|invalid arguments|api error 400|api error 404|api error 409|api error 422/i.test(
      value,
    )
  ) {
    return new FreehireMcpError('invalid-input', false, 'Freehire rejected the request')
  }
  if (/api error 429/i.test(value)) {
    return new FreehireMcpError('rate-limit', true, 'Freehire rate limit reached')
  }
  if (/timed out|timeout/i.test(value)) {
    return new FreehireMcpError('timeout', true, 'Freehire request timed out')
  }
  if (/decode response/i.test(value)) {
    return new FreehireMcpError('malformed-response', false, 'Freehire returned a malformed response')
  }
  return new FreehireMcpError('provider', true, 'Freehire provider request failed')
}

export function parseFreehireToolResult(result: ToolResult): unknown {
  const text = toolText(result)
  if (result.isError) throw classifyFreehireToolError(text)
  try {
    return JSON.parse(text)
  } catch {
    throw new FreehireMcpError('malformed-response', false, 'Freehire returned invalid JSON')
  }
}

const normalizeSdkError = (error: unknown): FreehireMcpError => {
  if (error instanceof FreehireMcpError) return error
  const message = error instanceof Error ? error.message : ''
  if (/timed out|timeout|-32001/i.test(message)) {
    return new FreehireMcpError('timeout', true, 'Freehire request timed out')
  }
  return new FreehireMcpError('provider', true, 'Freehire MCP connection failed')
}

const withFreehireMcp = async <T>(
  config: FreehireMcpConfig,
  operation: (session: FreehireMcpSession) => Promise<T>,
): Promise<T> => {
  if (!config.token) {
    throw new FreehireMcpError('authentication', false, 'Freehire authentication is not configured')
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 60_000) {
    throw new FreehireMcpError('invalid-input', false, 'Freehire operation timeout is invalid')
  }

  const child = freehireProcess()

  const transport = new StdioClientTransport({
    command: child.command,
    args: [child.serverEntry],
    env: {
      FREEHIRE_TOKEN: config.token,
      FREEHIRE_API_URL,
    },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'personal-assistant-freehire', version: '1.0.0' })

  try {
    await client.connect(transport, { timeout: config.timeoutMs })
    const inventory = await client.listTools(undefined, { timeout: config.timeoutMs })
    const tools = new Set(inventory.tools.map(({ name }) => name))
    const session: FreehireMcpSession = {
      tools,
      callJson: async (name, args) => {
        if (!tools.has(name)) {
          throw new FreehireMcpError('missing-tool', false, `Required Freehire tool is unavailable: ${name}`)
        }
        try {
          const result = await client.callTool(
            { name, arguments: args },
            CallToolResultSchema,
            { timeout: config.timeoutMs },
          )
          return parseFreehireToolResult(result as unknown as ToolResult)
        } catch (error) {
          throw normalizeSdkError(error)
        }
      },
    }
    return await operation(session)
  } catch (error) {
    throw normalizeSdkError(error)
  } finally {
    try {
      await client.close()
    } catch {
      // The stdio transport also terminates the child when the connection closes.
    }
  }
}

const boundedString = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, max) : null
}

const nestedString = (value: unknown, keys: readonly string[], max: number): string | null => {
  const direct = boundedString(value, max)
  if (direct) return direct
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = boundedString(record[key], max)
    if (candidate) return candidate
  }
  return null
}

const firstString = (
  record: Record<string, unknown>,
  keys: readonly string[],
  max: number,
): string | null => {
  for (const key of keys) {
    const value = boundedString(record[key], max)
    if (value) return value
  }
  return null
}

const normalizeHttpsUrl = (record: Record<string, unknown>): string | null => {
  const value = firstString(
    record,
    ['url', 'link', 'posting_url', 'job_url', 'source_url', 'apply_url'],
    2048,
  )
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    url.hash = ''
    return url.href.slice(0, 2048)
  } catch {
    return null
  }
}

const normalizePostedAt = (record: Record<string, unknown>): string | null => {
  const value = firstString(record, ['posted_at', 'published_at', 'created_at'], 100)
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

export function normalizeFreehireJob(value: unknown, fallbackSlug?: string): FreehireJob {
  const parsed = rawJobSchema.safeParse(value)
  if (!parsed.success) {
    throw new FreehireMcpError('malformed-response', false, 'Freehire returned an invalid job')
  }
  const record = parsed.data
  const freehireId =
    firstString(record, ['public_slug', 'slug'], 200) ?? boundedString(fallbackSlug, 200)
  if (!freehireId) {
    throw new FreehireMcpError('malformed-response', false, 'Freehire job is missing its public slug')
  }

  return {
    freehireId,
    title: firstString(record, ['title', 'name'], 500),
    company:
      firstString(record, ['company_name'], 500) ??
      nestedString(record.company, ['name', 'title'], 500),
    description: firstString(record, ['description_markdown', 'description', 'body'], 200_000),
    url: normalizeHttpsUrl(record),
    location:
      firstString(record, ['location_name'], 500) ??
      nestedString(record.location, ['name', 'label', 'display_name'], 500),
    postedAt: normalizePostedAt(record),
  }
}

const sanitizeIgnored = (value: unknown): Array<{ name: string; suggestion?: string }> => {
  if (!Array.isArray(value)) return []
  return value.slice(0, 50).flatMap((item) => {
    if (typeof item === 'string') {
      const name = boundedString(item, 200)
      return name ? [{ name }] : []
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const name = firstString(record, ['param', 'name', 'key'], 200)
    if (!name) return []
    const suggestion = firstString(record, ['did_you_mean', 'suggestion'], 200)
    return [{ name, ...(suggestion ? { suggestion } : {}) }]
  })
}

const sanitizeIgnoredValues = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: Record<string, string[]> = {}
  for (const [key, raw] of Object.entries(value).slice(0, 50)) {
    const safeKey = boundedString(key, 100)
    const values = Array.isArray(raw) ? raw : [raw]
    const safeValues = values.flatMap((item) => {
      const safe = boundedString(item, 200)
      return safe ? [safe] : []
    })
    if (safeKey && safeValues.length > 0) output[safeKey] = safeValues.slice(0, 50)
  }
  return output
}

export const parseFreehireSearchResult = (value: unknown): FreehireSearchResult => {
  const parsed = searchPageSchema.safeParse(value)
  if (!parsed.success) {
    throw new FreehireMcpError('malformed-response', false, 'Freehire returned an invalid search result')
  }
  const jobsById = new Map<string, FreehireJob>()
  for (const raw of parsed.data.data) {
    const job = normalizeFreehireJob(raw)
    if (!jobsById.has(job.freehireId)) jobsById.set(job.freehireId, job)
  }
  return {
    jobs: Array.from(jobsById.values()),
    total: parsed.data.total,
    ignored: sanitizeIgnored(parsed.data.ignored),
    ignoredValues: sanitizeIgnoredValues(parsed.data.ignored_values),
  }
}

const facetWarnings = (
  value: unknown,
): Pick<FreehireSearchResult, 'ignored' | 'ignoredValues'> => {
  if (value === null || typeof value !== 'object') {
    throw new FreehireMcpError('malformed-response', false, 'Freehire returned invalid facet data')
  }
  if (Array.isArray(value)) return { ignored: [], ignoredValues: {} }
  const record = value as Record<string, unknown>
  return {
    ignored: sanitizeIgnored(record.ignored),
    ignoredValues: sanitizeIgnoredValues(record.ignored_values),
  }
}

const mergeWarnings = (
  facets: Pick<FreehireSearchResult, 'ignored' | 'ignoredValues'>,
  search: FreehireSearchResult,
): FreehireSearchResult => {
  const ignoredByKey = new Map<string, { name: string; suggestion?: string }>()
  for (const warning of [...facets.ignored, ...search.ignored]) {
    ignoredByKey.set(`${warning.name}\u0000${warning.suggestion ?? ''}`, warning)
  }
  const ignoredValues: Record<string, string[]> = { ...facets.ignoredValues }
  for (const [key, values] of Object.entries(search.ignoredValues)) {
    ignoredValues[key] = Array.from(new Set([...(ignoredValues[key] ?? []), ...values]))
  }
  return { ...search, ignored: Array.from(ignoredByKey.values()), ignoredValues }
}

export async function searchFreehire(
  config: FreehireMcpConfig,
  input: { query: string; limit: number; skills?: string[]; filters: FreehireFilters },
): Promise<FreehireSearchResult> {
  return withFreehireMcp(config, async (session) => {
    const facets = await session.callJson('facets', input.filters)
    const warnings = facetWarnings(facets)
    const page = await session.callJson('search', {
      query: input.query,
      limit: input.limit,
      offset: 0,
      ...(input.skills ? { skills: input.skills } : {}),
      ...input.filters,
    })
    return mergeWarnings(warnings, parseFreehireSearchResult(page))
  })
}

export async function getFreehireJob(
  config: FreehireMcpConfig,
  slug: string,
): Promise<FreehireJob> {
  return withFreehireMcp(config, async (session) => {
    const job = await session.callJson('job', { slug })
    return normalizeFreehireJob(job, slug)
  })
}

export async function trackFreehireJob(
  config: FreehireMcpConfig,
  input:
    | { operation: 'save'; slug: string }
    | { operation: 'mark_applied'; slug: string }
    | {
        operation: 'stage'
        slug: string
        stage:
          | 'applied'
          | 'screening'
          | 'responded'
          | 'interview'
          | 'offer'
          | 'accepted'
          | 'rejected'
          | 'withdrawn'
      },
): Promise<void> {
  return withFreehireMcp(config, async (session) => {
    if (input.operation === 'save') await session.callJson('save', { slug: input.slug })
    if (input.operation === 'mark_applied') await session.callJson('apply', { slug: input.slug })
    if (input.operation === 'stage') {
      await session.callJson('stage', { slug: input.slug, stage: input.stage })
    }
  })
}

export async function discoverFreehireTools(config: FreehireMcpConfig): Promise<string[]> {
  return withFreehireMcp(config, async ({ tools }) => Array.from(tools).sort())
}
