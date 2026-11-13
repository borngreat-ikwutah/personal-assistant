import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { requireApiSecret } from '../lib/auth'
import {
  MAX_CV_BYTES,
  createCvDb,
  createCvVersion,
  extensionForContentType,
  findVersionByIdempotencyKey,
  getCvDocument,
  getCvVersion,
  isCvContentType,
  listCvVersions,
  toCvMetadata,
} from '../lib/cv'
import { cvVersions } from '../lib/schema'

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
})

const versionParamSchema = z.object({
  versionId: z.coerce.number().int().positive(),
})

const formSchema = z.object({
  file: z.custom<File>((value) => value instanceof File, 'file is required'),
})

type ValidationHook = NonNullable<Parameters<typeof zValidator>[2]>
const reject422: ValidationHook = (result, c) => {
  if (!result.success) {
    return c.json({ ok: false as const, error: 'invalid request', issues: result.error.issues }, 422)
  }
}

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const errorResponse = (error: string, status: 409 | 413 | 415 | 500) =>
  Response.json({ ok: false as const, error }, { status })

export const cvRoutes = new Hono<{ Bindings: Env }>()
  .post(
    '/cv',
    requireApiSecret,
    zValidator('form', formSchema, reject422),
    async (c) => {
      const idempotencyKey = c.req.header('Idempotency-Key')
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return c.json({ ok: false as const, error: 'invalid idempotency key' }, 422)
      }

      const db = createCvDb(c.env.DB)
      const existing = await findVersionByIdempotencyKey(db, idempotencyKey)
      if (existing) {
        const document = await getCvDocument(db)
        return c.json({
          ok: true as const,
          version: toCvMetadata(existing, document?.currentVersionId ?? null),
          idempotent: true as const,
        })
      }

      const { file } = c.req.valid('form')
      if (file.size < 1 || file.size > MAX_CV_BYTES) {
        return errorResponse('file too large or empty', 413)
      }
      if (!isCvContentType(file.type)) {
        return errorResponse('unsupported file type', 415)
      }

      const bytes = await file.arrayBuffer()
      const sha256 = await sha256Hex(bytes)
      const versionId = crypto.randomUUID()
      const objectKey = `cv/versions/${versionId}.${extensionForContentType(file.type)}`

      try {
        await c.env.CV_FILES.put(objectKey, bytes, {
          httpMetadata: { contentType: file.type },
          customMetadata: { sha256, originalFilename: file.name },
        })
      } catch (error) {
        console.error('CV R2 write failed', { error: String(error), size: file.size })
        return errorResponse('failed to store file', 500)
      }

      try {
        const version = await createCvVersion(db, {
          objectKey,
          originalFilename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          sha256,
          idempotencyKey,
        })
        return c.json({ ok: true as const, version: toCvMetadata(version, version.id) }, 201)
      } catch (error) {
        try {
          const failedVersion = await findVersionByIdempotencyKey(db, idempotencyKey)
          if (failedVersion) await db.delete(cvVersions).where(eq(cvVersions.id, failedVersion.id))
        } catch (metadataCleanupError) {
          console.error('CV metadata cleanup failed', { error: String(metadataCleanupError) })
        }
        try {
          await c.env.CV_FILES.delete(objectKey)
        } catch (cleanupError) {
          console.error('CV R2 cleanup failed', { error: String(cleanupError), objectKey })
        }
        console.error('CV metadata write failed', { error: String(error), size: file.size })
        const retry = await findVersionByIdempotencyKey(db, idempotencyKey)
        if (retry) {
          const document = await getCvDocument(db)
          return c.json({
            ok: true as const,
            version: toCvMetadata(retry, document?.currentVersionId ?? null),
            idempotent: true as const,
          })
        }
        return errorResponse('failed to record file', 500)
      }
    },
  )
  .get(
    '/cv',
    requireApiSecret,
    zValidator('query', listQuerySchema, reject422),
    async (c) => {
      const { limit, offset } = c.req.valid('query')
      const result = await listCvVersions(createCvDb(c.env.DB), limit, offset)
      return c.json({ ok: true as const, ...result, limit, offset })
    },
  )
  .get(
    '/cv/:versionId',
    requireApiSecret,
    zValidator('param', versionParamSchema, reject422),
    async (c) => {
      const { versionId } = c.req.valid('param')
      const version = await getCvVersion(createCvDb(c.env.DB), versionId)
      if (!version) return c.json({ ok: false as const, error: 'not found' }, 404)
      return c.json({ ok: true as const, version })
    },
  )
