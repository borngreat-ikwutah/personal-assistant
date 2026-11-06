import { Hono } from 'hono'

export const marcoRoutes = new Hono<{ Bindings: Env }>().get('/marco', (c) => {
  return c.json({
    ok: true,
    message: 'marco?',
    status: 200,
    timestamp: new Date().toISOString(),
  })
})
