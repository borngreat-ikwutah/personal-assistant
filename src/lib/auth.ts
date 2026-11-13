import { createMiddleware } from 'hono/factory'
import { timingSafeEqual } from 'hono/utils/buffer'

export const requireApiSecret = createMiddleware(async (c, next) => {
  const provided = c.req.header('API_SECRET')
  const secret = c.env.API_SECRET
  const authorized =
    typeof provided === 'string' &&
    provided.length === secret.length &&
    timingSafeEqual(provided, secret)

  if (!authorized) {
    return c.json({ ok: false as const, error: 'unauthorized' }, 401)
  }

  await next()
})
