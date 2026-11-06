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

export type AppType = typeof routes

export default routes
