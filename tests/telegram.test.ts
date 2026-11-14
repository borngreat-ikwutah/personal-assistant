import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  formatTelegramJobResults,
  parseTelegramJobsCommand,
  sendTelegramMessage,
} from '../src/lib/telegram'

const configureTrigger = mock(() => {})
const triggerTask = mock(async () => ({ id: 'run_123' }))

mock.module('@trigger.dev/sdk', () => ({
  configure: configureTrigger,
  tasks: { trigger: triggerTask },
}))

const { telegramRoutes } = await import('../src/routes/messaging/telegram')
const originalFetch = globalThis.fetch
const telegramFetch = mock(async () => Response.json({ ok: true }))

const env = {
  API_SECRET: 'api-secret',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
  TELEGRAM_CHAT_ID: '42',
  TRIGGER_SECRET_KEY: 'trigger-secret',
} as Env

const postUpdate = (text: string, chatId = 42) =>
  telegramRoutes.request(
    '/telegram/webhook',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'webhook-secret',
      },
      body: JSON.stringify({
        update_id: 99,
        message: { message_id: 7, chat: { id: chatId }, text },
      }),
    },
    env,
  )

beforeEach(() => {
  configureTrigger.mockClear()
  triggerTask.mockClear()
  telegramFetch.mockClear()
  globalThis.fetch = telegramFetch as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('Telegram jobs command', () => {
  test('parses direct and bot-addressed searches', () => {
    expect(parseTelegramJobsCommand('/jobs backend engineer')).toEqual({
      kind: 'search',
      query: 'backend engineer',
    })
    expect(parseTelegramJobsCommand('/jobs@my_bot remote react')).toEqual({
      kind: 'search',
      query: 'remote react',
    })
    expect(parseTelegramJobsCommand('/jobs')).toEqual({
      kind: 'invalid',
      message: 'Usage: /jobs <search terms>',
    })
  })

  test('formats a bounded plain-text result list', () => {
    const text = formatTelegramJobResults('backend engineer', 12, [
      {
        freehireId: 'job-1',
        title: 'Backend Engineer',
        company: 'Acme',
        description: null,
        url: 'https://jobs.example.com/job-1',
        location: 'Remote',
        postedAt: null,
      },
    ])

    expect(text).toContain('Jobs for "backend engineer"')
    expect(text).toContain('Showing 1 of 12')
    expect(text).toContain('1. Backend Engineer')
    expect(text).toContain('https://jobs.example.com/job-1')
  })

  test('posts messages through the Telegram Bot API', async () => {
    expect(await sendTelegramMessage('token', 42, 'hello', telegramFetch as typeof fetch)).toBe(
      true,
    )
    const [url, init] = telegramFetch.mock.calls[0]!
    expect(url).toBe('https://api.telegram.org/bottoken/sendMessage')
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: 42,
      text: 'hello',
      link_preview_options: { is_disabled: true },
    })
  })

  test('queues a Freehire search and acknowledges the allowed chat', async () => {
    const response = await postUpdate('/jobs remote typescript')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, runId: 'run_123' })
    expect(configureTrigger).toHaveBeenCalledWith({ secretKey: 'trigger-secret' })
    expect(triggerTask).toHaveBeenCalledWith(
      'search-freehire',
      { query: 'remote typescript', limit: 5, telegramChatId: 42 },
      { idempotencyKey: 'telegram-jobs-99', idempotencyKeyTTL: '1d' },
    )
  })

  test('ignores commands from chats that are not authorized', async () => {
    const response = await postUpdate('/jobs remote typescript', 43)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(triggerTask).not.toHaveBeenCalled()
    expect(telegramFetch).not.toHaveBeenCalled()
  })
})
