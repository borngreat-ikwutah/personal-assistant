import { desc, eq, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { applyTransition } from '../lib/applications'
import { requireApiSecret } from '../lib/auth'
import { createDb } from '../lib/db'
import { APPLICATION_STATUSES, applications, listings } from '../lib/schema'

/**
 * Applications API (spec 0001 AC-3..AC-7). Single actor, every endpoint requires
 * the API_SECRET header; the database holds no secrets, so the handler layer is
 * the gate.
 */
const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const listQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
})

const decisionBodySchema = z.object({
  decision: z.enum(['approve', 'skip']),
})

/**
 * Spec 0001 AC-3 / AC-7: malformed or unknown values reach the caller as 422,
 * never as a silent pass. Shared shape across query, param, and body.
 */
type ValidationHook = NonNullable<Parameters<typeof zValidator>[2]>
const reject422 = (error: string): ValidationHook => {
  return (result, c) => {
    if (!result.success) {
      return c.json({ ok: false as const, error, issues: result.error.issues }, 422)
    }
  }
}

function transitionResponse(result: Awaited<ReturnType<typeof applyTransition>>): Response {
  if (result.ok) {
    return Response.json(result)
  }
  if (result.reason === 'not-found') {
    return Response.json({ ok: false as const, error: 'not found' }, { status: 404 })
  }
  return Response.json(
    { ok: false as const, error: 'conflict', currentStatus: result.currentStatus },
    { status: 409 },
  )
}

export const applicationRoutes = new Hono<{ Bindings: Env }>()
  .get(
    '/applications',
    requireApiSecret,
    zValidator('query', listQuerySchema, reject422('invalid query')),
    async (c) => {
      const { status, limit, offset } = c.req.valid('query')
      const db = createDb(c.env.DB)

      const items = await db
        .select({ application: applications, listing: listings })
        .from(applications)
        .innerJoin(listings, eq(applications.listingId, listings.id))
        .where(status ? eq(applications.status, status) : undefined)
        .orderBy(desc(applications.createdAt), desc(applications.id))
        .limit(limit)
        .offset(offset)

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(applications)
        .where(status ? eq(applications.status, status) : undefined)

      return c.json({ ok: true as const, total, limit, offset, items })
    },
  )
  .post(
    '/applications/:id/decision',
    requireApiSecret,
    zValidator('param', idParamSchema, reject422('invalid id')),
    zValidator('json', decisionBodySchema, reject422('invalid decision')),
    async (c) => {
      const { id } = c.req.valid('param')
      const { decision } = c.req.valid('json')
      const db = createDb(c.env.DB)

      const result = await applyTransition(
        db,
        id,
        decision === 'approve' ? 'approved' : 'skipped',
        'suggested',
      )
      return transitionResponse(result)
    },
  )
  .post(
    '/applications/:id/retry',
    requireApiSecret,
    zValidator('param', idParamSchema, reject422('invalid id')),
    async (c) => {
      const { id } = c.req.valid('param')
      const db = createDb(c.env.DB)

      const result = await applyTransition(db, id, 'approved', 'failed')
      return transitionResponse(result)
    },
  )
  .patch(
    '/applications/:id/handled',
    requireApiSecret,
    zValidator('param', idParamSchema, reject422('invalid id')),
    async (c) => {
      const { id } = c.req.valid('param')
      const db = createDb(c.env.DB)

      const result = await applyTransition(db, id, 'handled', 'replied')
      return transitionResponse(result)
    },
  )
