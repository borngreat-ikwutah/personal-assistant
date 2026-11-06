# Telegram Bot API — Webhook & Echo Notes

Source: research pass with **Crawl4AI** (v0.9.5, browserless HTTP strategy) over
<https://core.telegram.org/bots/api> on 2026-11-06. Document state at time of
capture: **Bot API 10.3** ("Rich Messages / Ephemeral messages" release, August
2026). Raw crawled markdown retained at machine-internal research storage; the
distilled facts below are what our worker relies on.

## Webhook mechanics

- Webhooks are registered with `setWebhook`; Telegram then sendss an HTTPS
  `POST` to the given URL containing a **JSON-serialized `Update`** object on
  every event.
- A webhook **must be HTTPS** (custom certs only for self-hosted setups).
- A response outside `2XY` status makes Telegram retry delivery and
  eventually give up; `2XY` (we return `200`) means accepted.
- Optional **`secret_token`** on `setWebhook` → every webhook request carries
  it in the `X-Telegram-Bot-Api-Secret-Token` request header. Our worker
  validates this header (constant-time compare against the `API_SECRET`
  worker secret) and answers `401` otherwise.
- `getWebhookInfo` (`WebhookInfo` object) reports current webhook state —
  used to verify the live registration.
- `deleteWebhook` removes the integration if we ever switch to polling
  (`getUpdates`); not applicable to this worker.

## `Update` (what the webhook receives)

- Exactly **one** optional substance field is present per update:
  `message`, `edited_message`, `channel_post`, `edited_channel_post`,
  business/callback/etc.
- `update_id` is always present (Integer, monotonic).

## `Message`

- `message_id` — unique inside the chat (Integer).
- `chat` — the conversation the message belongs to (`chat.id` numeric).
- `text` — present for text messages; optional overall (photos, stickers…).
- `from` — sender, may be empty for channels.

## Sending methods used

- **`copyMessage`** — copies a message of any kind into a target chat
  (parameters required: `chat_id`, `from_chat_id`, `message_id`). Unlike
  `forwardMessage`, the copy carries no link to the original. Returns
  `MessageId` on success. Limitation: service, paid media, giveaway +
  invoice messages can't be copied (our echo route replies `500` then).
- **`sendMessage`** — text messages only; requires `chat_id` + `text`
  (1–4096 chars); returns the sent `Message`. Not needed for the pure echo.

## Worker mapping (what our Telegram route must do)

1. `POST /telegram/webhook` receives a JSON `Update` → validate shape
   (zod: `update_id` + optional `message{message_id, chat.id, text?}`).
2. Verify `X-Telegram-Bot-Api-Secret-Token` == `API_SECRET` (401 else).
3. If a `message` is present: `copyMessage` it back into the same chat
   (that is the "return whatever the person sent" behavior, including
   non-text media). No message → `200 {"ok":true}` no-op.
4. `GET /env` must always keep reflecting **presence only** of
   `TELEGRAM_BOT_TOKEN` / `API_SECRET` — secrets are never echoed.

## Registration command (run after deploy)

```
grep '^API_SECRET=' .env | cut -d= -f2- | xargs -0 -I{} \
curl -s "https://api.telegram.org/bot$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-)/setWebhook" \
  -d "url=https://personal-assistant.iagocech2056.workers.dev/telegram/webhook" \
  -d "secret_token={}" \
  -d "allowed_updates=[\"message\"]"
```
`allowed_updates:["message"]` keeps the noisy update types away from the
echo endpoint.
