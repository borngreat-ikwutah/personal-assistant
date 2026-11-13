import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { requireApiSecret } from '../lib/auth'
import { createDb } from '../lib/db'
import { upsertFreehireListings } from '../lib/freehire-listings'

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional()

const listingSchema = z
  .object({
    freehireId: z.string().trim().min(1).max(200),
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value)
          return url.protocol === 'https:' && !url.username && !url.password
        } catch {
          return false
        }
      }, 'url must be a credential-free HTTPS URL')
      .nullable()
      .optional(),
    title: optionalText(500),
    company: optionalText(500),
    description: optionalText(200_000),
    postedAt: z.string().datetime({ offset: true }).nullable().optional(),
    location: optionalText(500),
  })
  .strict()

const ingestionSchema = z
  .object({
    listings: z.array(listingSchema).min(1).max(10),
  })
  .strict()
  .superRefine(({ listings }, context) => {
    const seen = new Set<string>()
    listings.forEach((listing, index) => {
      if (seen.has(listing.freehireId)) {
        context.addIssue({
          code: 'custom',
          message: 'freehireId values must be unique',
          path: ['listings', index, 'freehireId'],
        })
      }
      seen.add(listing.freehireId)
    })
  })

type ValidationHook = NonNullable<Parameters<typeof zValidator>[2]>
const reject422: ValidationHook = (result, c) => {
  if (!result.success) {
    return c.json({ ok: false as const, error: 'invalid request', issues: result.error.issues }, 422)
  }
}

export const freehireRoutes = new Hono<{ Bindings: Env }>().post(
  '/internal/freehire/listings',
  requireApiSecret,
  zValidator('json', ingestionSchema, reject422),
  async (c) => {
    const { listings } = c.req.valid('json')
    const result = await upsertFreehireListings(createDb(c.env.DB), listings)
    return c.json({ ok: true as const, ...result })
  },
)
