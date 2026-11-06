import { Hono } from 'hono'

// Full final paths are declared inside each module and modules are mounted at
// '/' — this keeps the RPC type contract flat (client base paths stay rooted),
// per the AGENTS.md structure rule.
export const baseRoutes = new Hono<{ Bindings: Env }>().get('/', (c) => {
  return c.text('Hello Hono!')
})
