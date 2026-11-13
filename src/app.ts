import { Hono } from 'hono'

import { baseRoutes } from './routes/base'
import { browserRoutes } from './routes/browser'
import { telegramRoutes } from './routes/messaging/telegram'
import { envRoutes } from './routes/env'
import { applicationRoutes } from './routes/applications'
import { cvRoutes } from './routes/cv'
import { freehireRoutes } from './routes/freehire'

const app = new Hono<{ Bindings: Env }>()

/**
 * Route modules each declare their full final paths and are mounted at '/',
 * keeping the chain flat for the RPC type contract (see AGENTS.md).
 */
const routes = app
  .route('/', baseRoutes)
  .route('/', envRoutes)
  .route('/', applicationRoutes)
  .route('/', browserRoutes)
  .route('/', cvRoutes)
  .route('/', freehireRoutes)
  .route('/', telegramRoutes)
  .notFound((c) => c.json({ ok: false, error: 'not found' }, 404))
  .onError((err, c) => {
    console.error('unhandled error:', err)
    return c.json({ ok: false, error: 'internal server error' }, 500)
  })

export type AppType = typeof routes

export { routes as default }
