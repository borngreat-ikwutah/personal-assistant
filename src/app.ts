import { Hono } from 'hono'

import { baseRoutes } from './routes/base'
import { envRoutes } from './routes/env'
import { telegramRoutes } from './routes/telegram'

const app = new Hono<{ Bindings: Env }>()

/**
 * Route modules each declare their full final paths and are mounted at '/',
 * keeping the chain flat for the RPC type contract (see AGENTS.md).
 */
const routes = app
  .route('/', baseRoutes)
  .route('/', envRoutes)
  .route('/', telegramRoutes)
  .notFound((c) => c.json({ ok: false, error: 'not found' }, 404))
  .onError((err, c) => {
    console.error('unhandled error:', err)
    return c.json({ ok: false, error: 'internal server error' }, 500)
  })

export type AppType = typeof routes

export { routes as default }
