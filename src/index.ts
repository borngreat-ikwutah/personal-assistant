import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/marco', (c) => {
  return c.json({
    ok: true,
    message: 'marco?',
    status: 200,
    timestamp: new Date().toISOString(),
  })
})

export default app
