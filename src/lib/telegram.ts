import type { FreehireJob } from './freehire-mcp'

const JOBS_COMMAND = /^\/jobs(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i
const MAX_QUERY_LENGTH = 500

export type TelegramJobsCommand =
  | { kind: 'other' }
  | { kind: 'invalid'; message: string }
  | { kind: 'search'; query: string }

export function parseTelegramJobsCommand(text: string): TelegramJobsCommand {
  const match = JOBS_COMMAND.exec(text.trim())
  if (!match) return { kind: 'other' }

  const query = match[1]?.trim() ?? ''
  if (!query) {
    return { kind: 'invalid', message: 'Usage: /jobs <search terms>' }
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { kind: 'invalid', message: 'Search terms must be 500 characters or fewer.' }
  }

  return { kind: 'search', query }
}

const oneLine = (value: string | null, maxLength: number): string | null => {
  if (!value) return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxLength - 3))}...`
}

const safeJobUrl = (value: string | null): string | null => {
  if (!value || value.length > 350) return null
  try {
    const url = new URL(value)
    const normalized = url.toString()
    return url.protocol === 'https:' && normalized.length <= 350 ? normalized : null
  } catch {
    return null
  }
}

export function formatTelegramJobResults(
  query: string,
  total: number,
  jobs: readonly FreehireJob[],
): string {
  const displayQuery = oneLine(query, 120) ?? 'your search'
  if (jobs.length === 0) return `No jobs found for "${displayQuery}".`

  const shownJobs = jobs.slice(0, 5)
  const blocks = shownJobs.map((job, index) => {
    const title = oneLine(job.title, 120) ?? 'Untitled role'
    const company = oneLine(job.company, 80)
    const location = oneLine(job.location, 80)
    const url = safeJobUrl(job.url)
    const details = [company, location].filter((value): value is string => Boolean(value))

    return [
      `${index + 1}. ${title}`,
      ...(details.length > 0 ? [details.join(' | ')] : []),
      ...(url ? [url] : []),
    ].join('\n')
  })

  return [
    `Jobs for "${displayQuery}"`,
    `Showing ${shownJobs.length} of ${total}`,
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    }),
  })

  return response.ok
}
