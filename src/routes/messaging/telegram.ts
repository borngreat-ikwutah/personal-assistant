import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'

/** Subset of the Telegram `Update` object that the echo webhook consumes. */
const messageSchema = z
  .object({
    message_id: z.number().int(),
    chat: z.object({
      id: z.number({ message: 'chat.id must be a number' }).int(),
    }),
    text: z.string().min(1).optional(),
  })
  .passthrough()

const updateSchema = z
  .object({
    update_id: z.number().int(),
    message: messageSchema.optional(),
  })
  .passthrough()

/**
 * Shared logic: return to the caller in `payload.chat` another copy of
 * `payload.content_type` message.
 */
const echoMessage = async (
  botToken: string,
  message: { chat: { id: number }; message_id: number }
): Promise<boolean> => {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/copyMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: message.chat.id,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    }),
  })

  return res.ok
}

// Constant-time comparison so webhook secret validation doesn't leak secrets
// through timing.
const secretsMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export const telegramRoutes = new Hono<{ Bindings: Env }>()
  .post('/telegram/webhook', zValidator('json', updateSchema), async (c) => {
    // Per Bot API 9.x-10.x: when setWebhook is called with `secret_token`,
    // every webhook request carries that value in this header. Reject anything
    // else — it didn't come from Telegram.
    const secretHeader = c.req.header('X-Telegram-Bot-Api-Secret-Token')
    if (!secretHeader || !secretsMatch(secretHeader, c.env.API_SECRET)) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }

    const botToken = c.env.TELEGRAM_BOT_TOKEN
    const update = c.req.valid('json')

    if (!update.message) {
      // Other update kinds (callback_query, edited_message, …) — nothing to echo.
      return c.json({ ok: true }, 200)
    }

    const echoed = await echoMessage(botToken, update.message)

    if (!echoed) {
      return c.json({ ok: false, error: 'failed to echo message' }, 500)
    }

    return c.json({ ok: true }, 200)
  })
