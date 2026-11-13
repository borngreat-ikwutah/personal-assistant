import { task } from '@trigger.dev/sdk'

import { getCvObject } from '../lib/cv-s3'

interface TriggerNodeEnv {
  process?: { env?: Record<string, string | undefined> }
}

const env = (globalThis as TriggerNodeEnv).process?.env ?? {}

export type ReadCvPayload = {
  objectKey: string
  expectedSha256?: string
}

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export const readCvTask = task({
  id: 'read-cv',
  maxDuration: 60,
  run: async (payload: ReadCvPayload) => {
    const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'] as const
    const missing = required.filter((key) => !env?.[key])
    if (missing.length > 0) throw new Error(`Missing R2 configuration: ${missing.join(', ')}`)

    const bytes = await getCvObject(payload.objectKey, {
      accountId: env.R2_ACCOUNT_ID!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      bucketName: env.R2_BUCKET_NAME!,
    })
    const sha256 = await sha256Hex(bytes)
    if (payload.expectedSha256 && payload.expectedSha256 !== sha256) {
      throw new Error('CV object digest did not match metadata')
    }
    return { byteCount: bytes.byteLength, sha256 }
  },
})
