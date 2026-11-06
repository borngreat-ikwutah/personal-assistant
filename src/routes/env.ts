import { Hono } from 'hono'

// Reports environment wiring. Presence booleans only — secret values are never
// echoed to a caller.
export const envRoutes = new Hono<{ Bindings: Env }>().get('/env', (c) => {
  return c.json({
    ok: true,
    APP_NAME: c.env.APP_NAME,
    hasApiSecret: c.env.API_SECRET.length > 0,
    hasTelegramBotToken: /^[0-9]+:[\w-]+$/.test(c.env.TELEGRAM_BOT_TOKEN),
  })
})
