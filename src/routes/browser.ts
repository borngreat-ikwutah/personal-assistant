import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { requireApiSecret } from '../lib/auth'
import { consumeBrowserApprovalNonce } from '../lib/browser-approvals'
import { MAX_BROWSER_APPROVAL_TTL_MS } from '../lib/browser-security'
import { createDb } from '../lib/db'

const approvalSchema = z
  .object({
    applicationId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/i),
    nonce: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
    issuedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

type ValidationHook = NonNullable<Parameters<typeof zValidator>[2]>
const reject422: ValidationHook = (result, c) => {
  if (!result.success) {
    return c.json({ ok: false as const, error: 'invalid request', issues: result.error.issues }, 422)
  }
}

export const browserRoutes = new Hono<{ Bindings: Env }>().post(
  '/internal/browser-approvals/consume',
  requireApiSecret,
  zValidator('json', approvalSchema, reject422),
  async (c) => {
    const approval = c.req.valid('json')
    const now = Date.now()
    if (
      approval.issuedAt > now + 30_000 ||
      approval.expiresAt <= now ||
      approval.expiresAt <= approval.issuedAt ||
      approval.expiresAt - approval.issuedAt > MAX_BROWSER_APPROVAL_TTL_MS
    ) {
      return c.json({ ok: false as const, error: 'approval expired or invalid' }, 422)
    }

    const consumed = await consumeBrowserApprovalNonce(createDb(c.env.DB), approval)
    if (!consumed) {
      return c.json({ ok: false as const, error: 'approval already consumed' }, 409)
    }
    return c.json({ ok: true as const }, 201)
  },
)
