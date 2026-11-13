import { schemaTask } from '@trigger.dev/sdk'
import { chromium, type Locator, type Page } from 'playwright'
import { Agent, fetch as pinnedFetch, getSetCookies } from 'undici'
import { z } from 'zod'

import {
  BrowserApprovalConsumptionError,
  consumeRemoteBrowserApproval,
} from '../lib/browser-approvals'
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  MAX_BROWSER_CV_BYTES,
  type BrowserAction,
  type BrowserAutomationPlan,
  browserAutomationManifest,
  openBrowserAutomationPlan,
  sealedBrowserPlanSchema,
} from '../lib/browser-plan'
import {
  assertPublicIpAddress,
  canonicalizeAllowedBrowserHost,
  canonicalizePublicHttpsUrl,
  createBrowserManifestDigest,
  timingSafeHexEqual,
  verifyBrowserApprovalReceipt,
} from '../lib/browser-security'
import { getCvObject } from '../lib/cv-s3'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i)
const MAX_PROXIED_RESPONSE_BYTES = 10 * 1024 * 1024

const browserApplySandboxSchema = z
  .object({
    applicationId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    targetUrl: z.string().min(1).max(2048),
    allowedHosts: z.array(z.string().min(1).max(253)).max(5).default([]),
    sealedPlan: sealedBrowserPlanSchema.optional(),
    approval: z
      .object({
        manifestDigest: digestSchema,
        nonce: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
        issuedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        signature: digestSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.sealedPlan) !== Boolean(value.approval)) {
      context.addIssue({
        code: 'custom',
        message: 'sealedPlan and approval must be supplied together',
        path: value.sealedPlan ? ['approval'] : ['sealedPlan'],
      })
    }
  })

type BrowserApplySandboxPayload = z.infer<typeof browserApplySandboxSchema>

interface TriggerNodeEnv {
  process?: { env?: Record<string, string | undefined> }
  Buffer?: { from: (value: ArrayBuffer) => Uint8Array }
}

type R2Config = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucketName: string
}

type BlockedNetworkState = {
  attempts: number
  hostnames: Set<string>
}

class BrowserSandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserSandboxError'
  }
}

const getEnv = (): Record<string, string | undefined> =>
  (globalThis as TriggerNodeEnv).process?.env ?? {}

const getR2Config = (): R2Config => {
  const env = getEnv()
  const accountId = env.R2_ACCOUNT_ID
  const accessKeyId = env.R2_ACCESS_KEY_ID
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY
  const bucketName = env.R2_BUCKET_NAME
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new BrowserSandboxError('Browser CV upload is not configured')
  }
  return { accountId, accessKeyId, secretAccessKey, bucketName }
}

const getApprovalConfig = () => {
  const env = getEnv()
  const approvalSecret = env.BROWSER_APPROVAL_SECRET
  const apiUrl = env.JOB_AGENT_API_URL
  const apiSecret = env.JOB_AGENT_API_SECRET
  if (!approvalSecret || !apiUrl || !apiSecret) {
    throw new BrowserSandboxError('Browser approval execution is not configured')
  }
  return { approvalSecret, apiUrl, apiSecret }
}

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const uploadCv = async (
  locator: Locator,
  action: Extract<BrowserAction, { type: 'uploadCv' }>,
): Promise<void> => {
  let bytes: ArrayBuffer
  try {
    bytes = await getCvObject(action.objectKey, getR2Config())
  } catch (error) {
    if (error instanceof BrowserSandboxError) throw error
    throw new BrowserSandboxError('CV object could not be loaded')
  }

  try {
    if (bytes.byteLength > MAX_BROWSER_CV_BYTES) {
      throw new BrowserSandboxError('CV object is too large')
    }
    if ((await sha256Hex(bytes)) !== action.expectedSha256.toLowerCase()) {
      throw new BrowserSandboxError('CV object digest did not match')
    }

    const buffer = (globalThis as TriggerNodeEnv).Buffer?.from(bytes)
    if (!buffer) throw new BrowserSandboxError('Browser file upload is unavailable')
    const file = {
      name: action.filename,
      mimeType: action.contentType,
      buffer,
    } as Parameters<Locator['setInputFiles']>[0]
    await locator.setInputFiles(file)
  } finally {
    new Uint8Array(bytes).fill(0)
  }
}

const isGuardedClick = async (locator: Locator): Promise<boolean> =>
  locator.evaluate((element) => {
    const control =
      element.closest('button, input, [role="button"], a, [form], [type="submit"], [type="image"]') ??
      element
    const type = control.getAttribute('type')?.toLowerCase() ?? ''
    const descriptor = [
      control.textContent,
      control.getAttribute('aria-label'),
      control.getAttribute('title'),
      control.getAttribute('name'),
      control.getAttribute('value'),
      control.getAttribute('id'),
      control.getAttribute('class'),
      control.getAttribute('href'),
      control.getAttribute('formaction'),
    ]
      .filter(Boolean)
      .join(' ')

    return (
      element.closest('form') !== null ||
      control.closest('form') !== null ||
      control.hasAttribute('form') ||
      Boolean(Reflect.get(control, 'form')) ||
      type === 'submit' ||
      type === 'image' ||
      /\b(?:submit|apply|application|finish|complete|send)\b/i.test(descriptor)
    )
  })

const executeAction = async (page: Page, action: BrowserAction): Promise<void> => {
  const locator = page.locator(action.selector)

  switch (action.type) {
    case 'wait':
      await locator.waitFor({
        state: action.state,
        timeout: action.timeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
      })
      return
    case 'fill':
      await locator.fill(action.value, { timeout: DEFAULT_BROWSER_ACTION_TIMEOUT_MS })
      return
    case 'select':
      await locator.selectOption(action.value, { timeout: DEFAULT_BROWSER_ACTION_TIMEOUT_MS })
      return
    case 'check':
      await locator.check({ timeout: DEFAULT_BROWSER_ACTION_TIMEOUT_MS })
      return
    case 'uncheck':
      await locator.uncheck({ timeout: DEFAULT_BROWSER_ACTION_TIMEOUT_MS })
      return
    case 'click':
      if (await isGuardedClick(locator)) {
        throw new BrowserSandboxError('Preparation click was blocked by the submit guard')
      }
      await locator.click({ timeout: DEFAULT_BROWSER_ACTION_TIMEOUT_MS })
      return
    case 'uploadCv':
      await uploadCv(locator, action)
  }
}

const metadataHostname = (value: string): string | undefined => {
  try {
    let hostname = new URL(value).hostname.toLowerCase()
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
    if (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
    return hostname && hostname.length <= 253 ? hostname : undefined
  } catch {
    return undefined
  }
}

const recordBlockedNetwork = (blocked: BlockedNetworkState, url: string): void => {
  blocked.attempts += 1
  const hostname = metadataHostname(url)
  if (hostname && blocked.hostnames.size < 20) blocked.hostnames.add(hostname)
}

const sensitiveValues = (plan: BrowserAutomationPlan): string[] =>
  plan.actions.flatMap((action) => {
    if (action.type === 'fill' || action.type === 'select') return action.value ? [action.value] : []
    if (action.type === 'uploadCv') return [action.filename]
    return []
  })

const containsSensitiveValue = (value: string, sensitive: string[]): boolean => {
  const normalized = value.toLocaleLowerCase()
  return sensitive.some((entry) => entry && normalized.includes(entry.toLocaleLowerCase()))
}

const containsSensitiveUrlValue = (value: string, sensitive: string[]): boolean => {
  if (containsSensitiveValue(value, sensitive)) return true
  try {
    return containsSensitiveValue(decodeURIComponent(value), sensitive)
  } catch {
    return false
  }
}

type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>

type ResolvedHost = { address: string; family: 4 | 6 }

const resolvePublicHosts = async (
  hostnames: readonly string[],
): Promise<{ resolverRules: string; pins: ReadonlyMap<string, ResolvedHost> }> => {
  const dnsModuleName = 'node:dns/promises'
  const dns = (await import(dnsModuleName)) as { lookup: DnsLookup }
  const rules: string[] = []
  const pins = new Map<string, ResolvedHost>()

  for (const hostname of [...hostnames].sort()) {
    let addresses: Awaited<ReturnType<DnsLookup>>
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true })
    } catch {
      throw new BrowserSandboxError('Browser target DNS resolution failed')
    }
    if (addresses.length === 0) throw new BrowserSandboxError('Browser target DNS resolution failed')
    try {
      addresses.forEach(({ address }) => assertPublicIpAddress(address))
    } catch {
      throw new BrowserSandboxError('Browser target resolved to a rejected address')
    }
    const selected = addresses.find(({ family }) => family === 4) ?? addresses[0]
    if (selected.family !== 4 && selected.family !== 6) {
      throw new BrowserSandboxError('Browser target DNS resolution failed')
    }
    pins.set(hostname, { address: selected.address, family: selected.family })
    const address = selected.address.includes(':') ? `[${selected.address}]` : selected.address
    rules.push(`MAP ${hostname} ${address}`)
  }
  rules.push('MAP * ~NOTFOUND')
  return { resolverRules: rules.join(', '), pins }
}

const pinnedDispatcher = (pins: ReadonlyMap<string, ResolvedHost>): Agent =>
  new Agent({
    connect: {
      lookup: (hostname, _options, callback) => {
        const pin = pins.get(hostname.toLowerCase().replace(/\.$/, ''))
        if (!pin) {
          const error = new Error('Browser proxy hostname is not approved') as Error & {
            code?: string
          }
          error.code = 'ENOTFOUND'
          callback(error, '', 0)
          return
        }
        callback(null, pin.address, pin.family)
      },
    },
  })

const proxyRequestHeaders = (headers: Record<string, string>): Record<string, string> => {
  const output = { ...headers }
  delete output.host
  delete output.connection
  delete output['content-length']
  delete output['accept-encoding']
  return output
}

const proxyResponseHeaders = (headers: {
  forEach: (callback: (value: string, name: string) => void) => void
}): Record<string, string> => {
  const output: Record<string, string> = {}
  headers.forEach((value, name) => {
    const normalized = name.toLowerCase()
    if (
      normalized !== 'content-encoding' &&
      normalized !== 'content-length' &&
      normalized !== 'transfer-encoding' &&
      normalized !== 'connection' &&
      normalized !== 'set-cookie'
    ) {
      output[name] = value
    }
  })
  return output
}

const defaultCookiePath = (pathname: string): string => {
  if (!pathname.startsWith('/') || pathname === '/') return '/'
  const lastSlash = pathname.lastIndexOf('/')
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash)
}

const approvedPlan = async (
  payload: BrowserApplySandboxPayload,
  targetUrl: string,
  allowedHosts: readonly string[],
): Promise<{ plan: BrowserAutomationPlan; expiresAt?: number }> => {
  if (!payload.sealedPlan || !payload.approval) return { plan: { actions: [] } }

  const config = getApprovalConfig()
  let plan: BrowserAutomationPlan
  try {
    plan = await openBrowserAutomationPlan(
      payload.sealedPlan,
      { applicationId: payload.applicationId, targetUrl },
      config.approvalSecret,
    )
  } catch {
    throw new BrowserSandboxError('Browser automation plan is invalid')
  }

  const manifestDigest = await createBrowserManifestDigest(
    browserAutomationManifest(payload.applicationId, targetUrl, allowedHosts, plan),
  )
  const receipt = {
    applicationId: payload.applicationId,
    targetUrl,
    manifestDigest: payload.approval.manifestDigest,
    nonce: payload.approval.nonce,
    issuedAt: payload.approval.issuedAt,
    expiresAt: payload.approval.expiresAt,
    signature: payload.approval.signature,
  }
  if (
    !timingSafeHexEqual(manifestDigest, payload.approval.manifestDigest) ||
    !(await verifyBrowserApprovalReceipt(receipt, config.approvalSecret))
  ) {
    throw new BrowserSandboxError('Browser automation approval is invalid or expired')
  }

  try {
    await consumeRemoteBrowserApproval(
      {
        applicationId: payload.applicationId,
        manifestDigest,
        nonce: payload.approval.nonce,
        issuedAt: payload.approval.issuedAt,
        expiresAt: payload.approval.expiresAt,
      },
      config,
    )
  } catch (error) {
    if (error instanceof BrowserApprovalConsumptionError) {
      throw new BrowserSandboxError(error.message)
    }
    throw new BrowserSandboxError('Browser approval could not be consumed')
  }
  return { plan, expiresAt: payload.approval.expiresAt }
}

const runBrowserSandbox = async (payload: BrowserApplySandboxPayload) => {
  let target: ReturnType<typeof canonicalizePublicHttpsUrl>
  let allowedHosts: string[]
  try {
    target = canonicalizePublicHttpsUrl(payload.targetUrl)
    allowedHosts = Array.from(
      new Set([target.hostname, ...payload.allowedHosts.map(canonicalizeAllowedBrowserHost)]),
    ).sort()
  } catch {
    throw new BrowserSandboxError('Browser target or allowed hostname was rejected')
  }

  const approval = await approvedPlan(payload, target.canonicalUrl, allowedHosts)
  const plan = approval.plan
  const sensitive = sensitiveValues(plan)
  const allowedOrigins = new Set(
    allowedHosts.map((hostname) =>
      canonicalizePublicHttpsUrl(`https://${hostname.includes(':') ? `[${hostname}]` : hostname}/`).url
        .origin,
    ),
  )
  let expectedSubmissionRequest:
    | { method: 'POST' | 'PUT' | 'PATCH'; url: string; remaining: number }
    | undefined
  if (plan.finalSubmit) {
    let requestTarget: ReturnType<typeof canonicalizePublicHttpsUrl>
    try {
      requestTarget = canonicalizePublicHttpsUrl(plan.finalSubmit.request.url)
    } catch {
      throw new BrowserSandboxError('Approved submission request URL is invalid')
    }
    if (!allowedOrigins.has(requestTarget.url.origin)) {
      throw new BrowserSandboxError('Approved submission request origin is not allowed')
    }
    expectedSubmissionRequest = {
      method: plan.finalSubmit.request.method,
      url: requestTarget.canonicalUrl,
      remaining: 1,
    }
  }
  const resolvedHosts = await resolvePublicHosts(allowedHosts)
  const blocked: BlockedNetworkState = { attempts: 0, hostnames: new Set() }
  let submissionWindowOpen = false
  let activeProxyRequests = 0
  let totalProxiedBytes = 0
  const dispatcher = pinnedDispatcher(resolvedHosts.pins)

  try {
    const browser = await chromium.launch({
      headless: true,
      args: [
        `--host-resolver-rules=${resolvedHosts.resolverRules}`,
        '--disable-quic',
        '--disable-webrtc',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    })
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
      })
      try {
        context.setDefaultTimeout(DEFAULT_BROWSER_ACTION_TIMEOUT_MS)
        context.setDefaultNavigationTimeout(30_000)
        await context.addInitScript(() => {
          const scope = globalThis as unknown as Record<string, unknown>
          for (const name of [
            'open',
            'RTCPeerConnection',
            'webkitRTCPeerConnection',
            'WebTransport',
          ]) {
            try {
              Object.defineProperty(scope, name, {
                value: name === 'open' ? () => null : undefined,
                configurable: false,
                writable: false,
              })
            } catch {
              // Chromium flags and the network proxy remain the primary boundary.
            }
          }
        })
        await context.routeWebSocket('**/*', (webSocket) => {
          recordBlockedNetwork(blocked, webSocket.url())
          webSocket.close({ code: 1008, reason: 'WebSocket blocked by browser sandbox' })
        })
        await context.route('**/*', async (route) => {
          const request = route.request()
          let requestTarget: ReturnType<typeof canonicalizePublicHttpsUrl>
          try {
            requestTarget = canonicalizePublicHttpsUrl(request.url())
            if (!allowedOrigins.has(requestTarget.url.origin)) {
              recordBlockedNetwork(blocked, request.url())
              await route.abort('blockedbyclient')
              return
            }
          } catch {
            recordBlockedNetwork(blocked, request.url())
            await route.abort('blockedbyclient')
            return
          }

          const method = request.method().toUpperCase()
          const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
          if (!safeMethod) {
            let requestUrl: string | undefined
            try {
              requestUrl = canonicalizePublicHttpsUrl(request.url()).canonicalUrl
            } catch {
              // The destination check above already records and blocks invalid URLs.
            }
            if (
              !submissionWindowOpen ||
              !expectedSubmissionRequest ||
              expectedSubmissionRequest.remaining !== 1 ||
              approval.expiresAt === undefined ||
              approval.expiresAt <= Date.now() ||
              method !== expectedSubmissionRequest.method ||
              requestUrl !== expectedSubmissionRequest.url
            ) {
              recordBlockedNetwork(blocked, request.url())
              await route.abort('blockedbyclient')
              return
            }
            expectedSubmissionRequest.remaining = 0
          }
          if (!submissionWindowOpen && containsSensitiveUrlValue(request.url(), sensitive)) {
            recordBlockedNetwork(blocked, request.url())
            await route.abort('blockedbyclient')
            return
          }

          if (activeProxyRequests >= 8) {
            recordBlockedNetwork(blocked, request.url())
            await route.abort('blockedbyclient')
            return
          }
          activeProxyRequests += 1
          try {
            const response = await pinnedFetch(request.url(), {
              dispatcher,
              method,
              headers: proxyRequestHeaders(request.headers()),
              body: safeMethod ? undefined : (request.postDataBuffer() ?? undefined),
              redirect: 'manual',
              signal: AbortSignal.timeout(30_000),
            })
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              await response.body?.cancel()
              recordBlockedNetwork(blocked, request.url())
              await route.abort('blockedbyclient')
              return
            }
            const contentLength = Number(response.headers.get('content-length') ?? 0)
            if (Number.isFinite(contentLength) && contentLength > MAX_PROXIED_RESPONSE_BYTES) {
              await response.body?.cancel()
              recordBlockedNetwork(blocked, request.url())
              await route.abort('blockedbyclient')
              return
            }
            const chunks: Uint8Array[] = []
            let responseBytes = 0
            const reader = response.body?.getReader()
            if (reader) {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                responseBytes += value.byteLength
                totalProxiedBytes += value.byteLength
                if (
                  responseBytes > MAX_PROXIED_RESPONSE_BYTES ||
                  totalProxiedBytes > 50 * 1024 * 1024
                ) {
                  await reader.cancel()
                  recordBlockedNetwork(blocked, request.url())
                  await route.abort('blockedbyclient')
                  return
                }
                chunks.push(value)
              }
            }
            const merged = new Uint8Array(responseBytes)
            let bodyOffset = 0
            for (const chunk of chunks) {
              merged.set(chunk, bodyOffset)
              bodyOffset += chunk.byteLength
            }
            const body = (globalThis as TriggerNodeEnv).Buffer?.from(merged.buffer as ArrayBuffer)
            if (!body) throw new BrowserSandboxError('Browser proxy response buffer is unavailable')

            const cookies: Parameters<typeof context.addCookies>[0] = getSetCookies(
              response.headers,
            ).flatMap((cookie) => {
              const cookieDomain = cookie.domain?.replace(/^\./, '').toLowerCase()
              if (
                cookieDomain &&
                requestTarget.hostname !== cookieDomain &&
                !requestTarget.hostname.endsWith(`.${cookieDomain}`)
              ) {
                return []
              }
              const cookiePath = cookie.path ?? defaultCookiePath(requestTarget.url.pathname)
              let expires: number | undefined
              if (cookie.maxAge !== undefined) expires = Date.now() / 1_000 + cookie.maxAge
              else if (cookie.expires instanceof Date) expires = cookie.expires.getTime() / 1_000
              else if (typeof cookie.expires === 'number') {
                expires = cookie.expires > 1_000_000_000_000 ? cookie.expires / 1_000 : cookie.expires
              }
              return [
                {
                  name: cookie.name,
                  value: cookie.value,
                  ...(cookie.domain
                    ? { domain: cookie.domain, path: cookiePath }
                    : cookie.path && cookie.path !== defaultCookiePath(requestTarget.url.pathname)
                      ? { domain: requestTarget.hostname, path: cookie.path }
                      : { url: requestTarget.canonicalUrl }),
                  ...(expires !== undefined ? { expires } : {}),
                  ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
                  ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
                  ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
                },
              ]
            })
            if (cookies.length > 0) await context.addCookies(cookies)
            await route.fulfill({
              status: response.status,
              headers: proxyResponseHeaders(response.headers),
              body: body as never,
            })
          } catch (error) {
            if (error instanceof BrowserSandboxError) throw error
            recordBlockedNetwork(blocked, request.url())
            await route.abort('failed')
          } finally {
            activeProxyRequests -= 1
          }
        })

        let primaryPage: Page | undefined
        context.on('page', (candidate) => {
          if (primaryPage && candidate !== primaryPage) void candidate.close()
        })
        const page = await context.newPage()
        primaryPage = page
        await page.goto(target.canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

        let actionCount = 0
        for (let index = 0; index < plan.actions.length; index += 1) {
          try {
            if (approval.expiresAt !== undefined && approval.expiresAt <= Date.now()) {
              throw new BrowserSandboxError('Browser automation approval expired during preparation')
            }
            await executeAction(page, plan.actions[index])
            actionCount += 1
          } catch (error) {
            if (error instanceof BrowserSandboxError) throw error
            throw new BrowserSandboxError(`Browser preparation action ${index + 1} failed`)
          }
        }

        let submissionAttempted = false
        let submissionConfirmed = false
        if (plan.finalSubmit) {
          if (approval.expiresAt === undefined || approval.expiresAt <= Date.now()) {
            throw new BrowserSandboxError('Browser automation approval expired before submission')
          }
          if (!expectedSubmissionRequest) {
            throw new BrowserSandboxError('Approved submission request is missing')
          }
          const confirmation = page.locator(plan.finalSubmit.confirmationSelector)
          if (await confirmation.isVisible()) {
            throw new BrowserSandboxError('Submission confirmation was visible before submission')
          }
          const responsePromise = page.waitForResponse(
            (response) => {
              try {
                return (
                  response.request().method().toUpperCase() === expectedSubmissionRequest?.method &&
                  canonicalizePublicHttpsUrl(response.url()).canonicalUrl ===
                    expectedSubmissionRequest?.url
                )
              } catch {
                return false
              }
            },
            { timeout: plan.finalSubmit.confirmationTimeoutMs ?? 30_000 },
          )
          submissionWindowOpen = true
          submissionAttempted = true
          try {
            const [response] = await Promise.all([
              responsePromise,
              page
                .locator(plan.finalSubmit.selector)
                .click({ timeout: DEFAULT_BROWSER_ACTION_TIMEOUT_MS }),
            ])
            if (response.status() < 200 || response.status() >= 400) {
              throw new BrowserSandboxError('Submission request did not succeed')
            }
            await confirmation.waitFor({
              state: 'visible',
              timeout: plan.finalSubmit.confirmationTimeoutMs ?? 30_000,
            })
            submissionConfirmed = true
            actionCount += 1
          } finally {
            submissionWindowOpen = false
          }
        }

        try {
          const finalTarget = canonicalizePublicHttpsUrl(page.url())
          if (!allowedOrigins.has(finalTarget.url.origin)) throw new Error('Unexpected final origin')
        } catch {
          throw new BrowserSandboxError('Browser ended at a rejected location')
        }

        return {
          applicationId: payload.applicationId,
          actionCount,
          submissionAttempted,
          submissionConfirmed,
          blockedNetworkRequestCount: blocked.attempts,
        }
      } finally {
        await context.close()
      }
    } finally {
      await browser.close()
    }
  } finally {
    await dispatcher.close()
  }
}

export const browserApplySandboxTask = schemaTask({
  id: 'browser-apply-sandbox',
  schema: browserApplySandboxSchema,
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    try {
      return await runBrowserSandbox(payload)
    } catch (error) {
      if (error instanceof BrowserSandboxError) throw error
      throw new BrowserSandboxError('Browser sandbox execution failed')
    }
  },
})
