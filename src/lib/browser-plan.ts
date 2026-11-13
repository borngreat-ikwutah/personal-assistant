import { z } from 'zod'

import {
  BrowserSecurityError,
  canonicalizeAllowedBrowserHost,
  canonicalizePublicHttpsUrl,
  createBrowserApprovalSignature,
  createBrowserManifestDigest,
} from './browser-security'

export const MAX_BROWSER_ACTIONS = 20
export const MAX_BROWSER_CV_BYTES = 10 * 1024 * 1024
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 15_000
export const PDF_CONTENT_TYPE = 'application/pdf'
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const browserSelectorSchema = z.string().trim().min(1).max(512)
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i)
const objectKeySchema = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/)

const waitActionSchema = z
  .object({
    type: z.literal('wait'),
    selector: browserSelectorSchema,
    state: z.enum(['attached', 'visible', 'hidden', 'detached']).default('visible'),
    timeoutMs: z.number().int().min(100).max(DEFAULT_BROWSER_ACTION_TIMEOUT_MS).optional(),
  })
  .strict()

const fillActionSchema = z
  .object({
    type: z.literal('fill'),
    selector: browserSelectorSchema,
    value: z.string().max(8_000),
  })
  .strict()

const selectActionSchema = z
  .object({
    type: z.literal('select'),
    selector: browserSelectorSchema,
    value: z.string().min(1).max(1_000),
  })
  .strict()

const checkActionSchema = z
  .object({
    type: z.enum(['check', 'uncheck']),
    selector: browserSelectorSchema,
  })
  .strict()

const clickActionSchema = z
  .object({
    type: z.literal('click'),
    selector: browserSelectorSchema,
  })
  .strict()

const uploadBaseSchema = {
  type: z.literal('uploadCv'),
  selector: browserSelectorSchema,
  objectKey: objectKeySchema,
  expectedSha256: digestSchema,
}

const uploadPdfActionSchema = z
  .object({
    ...uploadBaseSchema,
    filename: z
      .string()
      .min(5)
      .max(255)
      .regex(/^[^/\\\u0000-\u001f\u007f]+\.pdf$/i),
    contentType: z.literal(PDF_CONTENT_TYPE),
  })
  .strict()

const uploadDocxActionSchema = z
  .object({
    ...uploadBaseSchema,
    filename: z
      .string()
      .min(6)
      .max(255)
      .regex(/^[^/\\\u0000-\u001f\u007f]+\.docx$/i),
    contentType: z.literal(DOCX_CONTENT_TYPE),
  })
  .strict()

export const browserActionSchema = z.union([
  waitActionSchema,
  fillActionSchema,
  selectActionSchema,
  checkActionSchema,
  clickActionSchema,
  uploadPdfActionSchema,
  uploadDocxActionSchema,
])

export const browserAutomationPlanSchema = z
  .object({
    actions: z.array(browserActionSchema).max(MAX_BROWSER_ACTIONS),
    finalSubmit: z
      .object({
        selector: browserSelectorSchema,
        confirmationSelector: browserSelectorSchema,
        confirmationTimeoutMs: z.number().int().min(100).max(30_000).optional(),
        request: z
          .object({
            method: z.enum(['POST', 'PUT', 'PATCH']),
            url: z.string().min(1).max(2048),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const sealedBrowserPlanSchema = z
  .string()
  .min(64)
  .max(1_000_000)
  .regex(/^v1\.[a-f0-9]{24}\.[a-f0-9]+$/i)

export type BrowserAction = z.infer<typeof browserActionSchema>
export type BrowserAutomationPlan = z.infer<typeof browserAutomationPlanSchema>

export function browserAutomationManifest(
  applicationId: string,
  targetUrl: string,
  allowedHosts: readonly string[],
  plan: BrowserAutomationPlan,
) {
  const target = canonicalizePublicHttpsUrl(targetUrl)
  const hosts = Array.from(
    new Set([target.hostname, ...allowedHosts.map(canonicalizeAllowedBrowserHost)]),
  ).sort()
  return {
    version: 'browser-plan-v1',
    applicationId,
    targetUrl: target.canonicalUrl,
    allowedHosts: hosts,
    plan: browserAutomationPlanSchema.parse(plan),
  }
}

type BrowserPlanContext = {
  applicationId: string
  targetUrl: string
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const hexToBytes = (value: string): Uint8Array => {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) throw new BrowserSecurityError('Sealed browser plan is invalid')
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

const planKey = async (secret: string): Promise<CryptoKey> => {
  if (encoder.encode(secret).byteLength < 32) {
    throw new BrowserSecurityError('Browser plan secret is invalid')
  }
  const material = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`browser-plan-encryption-v1\u0000${secret}`),
  )
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

const additionalData = ({ applicationId, targetUrl }: BrowserPlanContext): Uint8Array => {
  const target = canonicalizePublicHttpsUrl(targetUrl)
  return encoder.encode(JSON.stringify(['browser-plan-v1', applicationId, target.canonicalUrl]))
}

export async function sealBrowserAutomationPlan(
  value: BrowserAutomationPlan,
  context: BrowserPlanContext,
  secret: string,
): Promise<string> {
  const plan = browserAutomationPlanSchema.parse(value)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(context) },
    await planKey(secret),
    encoder.encode(JSON.stringify(plan)),
  )
  return `v1.${bytesToHex(iv)}.${bytesToHex(new Uint8Array(encrypted))}`
}

export async function openBrowserAutomationPlan(
  value: string,
  context: BrowserPlanContext,
  secret: string,
): Promise<BrowserAutomationPlan> {
  try {
    const sealed = sealedBrowserPlanSchema.parse(value)
    const [, ivHex, ciphertextHex] = sealed.split('.')
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: hexToBytes(ivHex),
        additionalData: additionalData(context),
      },
      await planKey(secret),
      hexToBytes(ciphertextHex),
    )
    return browserAutomationPlanSchema.parse(JSON.parse(decoder.decode(decrypted)))
  } catch {
    throw new BrowserSecurityError('Sealed browser plan could not be opened')
  }
}

export async function createBrowserAutomationApprovalBundle(
  input: {
    applicationId: string
    targetUrl: string
    allowedHosts: readonly string[]
    plan: BrowserAutomationPlan
    nonce: string
    issuedAt: number
    expiresAt: number
  },
  secret: string,
) {
  const manifest = browserAutomationManifest(
    input.applicationId,
    input.targetUrl,
    input.allowedHosts,
    input.plan,
  )
  const manifestDigest = await createBrowserManifestDigest(manifest)
  const signature = await createBrowserApprovalSignature(
    {
      applicationId: input.applicationId,
      targetUrl: manifest.targetUrl,
      manifestDigest,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
    secret,
  )
  const targetHostname = canonicalizePublicHttpsUrl(manifest.targetUrl).hostname
  const extraHosts = manifest.allowedHosts.filter((hostname) => hostname !== targetHostname)
  if (extraHosts.length > 5) throw new BrowserSecurityError('Too many browser target hosts')
  return {
    applicationId: input.applicationId,
    targetUrl: manifest.targetUrl,
    allowedHosts: extraHosts,
    sealedPlan: await sealBrowserAutomationPlan(
      manifest.plan,
      { applicationId: input.applicationId, targetUrl: manifest.targetUrl },
      secret,
    ),
    approval: {
      manifestDigest,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      signature,
    },
  }
}
