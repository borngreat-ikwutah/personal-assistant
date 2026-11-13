import { Hono } from 'hono'

import { baseRoutes } from './routes/base'
import { telegramRoutes } from './routes/messaging/telegram'
import { envRoutes } from './routes/env'
import { applicationRoutes } from './routes/applications'
import { testGenerateRoutes } from './routes/ai/test-generate'
import { cvRoutes } from './routes/cv'

const app = new Hono<{ Bindings: Env }>()

/**
 * Route modules each declare their full final paths and are mounted at '/',
 * keeping the chain flat for the RPC type contract (see AGENTS.md).
 */
const routes = app
  .route('/', baseRoutes)
  .route('/', envRoutes)
  .route('/', applicationRoutes)
  .route('/', cvRoutes)
  .route('/', telegramRoutes)
  .route('/', testGenerateRoutes) // TEMPORARY public test endpoint (see module) — remove later
  .notFound((c) => c.json({ ok: false, error: 'not found' }, 404))
  .onError((err, c) => {
    console.error('unhandled error:', err)
    return c.json({ ok: false, error: 'internal server error' }, 500)
  })

export type AppType = typeof routes

export { routes as default }
