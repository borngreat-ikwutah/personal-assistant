import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

const routes = app
  .get('/', (c) => {
    return c.text('Hello Hono!')
  })
  .get('/marco', (c) => {
    return c.json({
      ok: true,
      message: 'marco?',
      status: 200,
      timestamp: new Date().toISOString(),
    })
  })
  .get('/env', (c) => {
    return c.json({
      ok: true,
      APP_NAME: c.env.APP_NAME,
      hasApiSecret: typeof c.env.API_SECRET === 'string' && c.env.API_SECRET.length > 0,
    })
  })

export type AppType = typeof routes

export default routes
