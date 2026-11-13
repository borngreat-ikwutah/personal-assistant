import { and, like, sql } from 'drizzle-orm'

import type { AppDatabase } from './db'
import { config as configTable } from './schema'

export type BrowserApprovalConsumption = {
  applicationId: string
  manifestDigest: string
  nonce: string
  issuedAt: number
  expiresAt: number
}

export async function consumeBrowserApprovalNonce(
  db: AppDatabase,
  approval: BrowserApprovalConsumption,
): Promise<boolean> {
  await db
    .delete(configTable)
    .where(
      and(
        like(configTable.key, 'browser-approval:%'),
        sql`cast(json_extract(${configTable.value}, '$.expiresAt') as integer) <= ${Date.now()}`,
      ),
    )

  const [inserted] = await db
    .insert(configTable)
    .values({
      key: `browser-approval:${approval.nonce}`,
      value: JSON.stringify({
        applicationId: approval.applicationId,
        manifestDigest: approval.manifestDigest,
        issuedAt: approval.issuedAt,
        expiresAt: approval.expiresAt,
      }),
    })
    .onConflictDoNothing({ target: configTable.key })
    .returning({ key: configTable.key })
  return inserted !== undefined
}

export class BrowserApprovalConsumptionError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'BrowserApprovalConsumptionError'
  }
}

const consumptionEndpoint = (apiUrl: string): URL => {
  let base: URL
  try {
    base = new URL(apiUrl)
  } catch {
    throw new BrowserApprovalConsumptionError('Job agent API URL is invalid', false)
  }
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new BrowserApprovalConsumptionError(
      'Job agent API URL must be a credential-free HTTPS URL',
      false,
    )
  }
  return new URL('/internal/browser-approvals/consume', base)
}

export async function consumeRemoteBrowserApproval(
  approval: BrowserApprovalConsumption,
  config: { apiUrl: string; apiSecret: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!config.apiSecret) {
    throw new BrowserApprovalConsumptionError('Job agent API secret is missing', false)
  }

  let response: Response
  try {
    response = await fetcher(consumptionEndpoint(config.apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        API_SECRET: config.apiSecret,
      },
      body: JSON.stringify(approval),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
  } catch {
    throw new BrowserApprovalConsumptionError('Browser approval consumption request failed', true)
  }

  if (response.status === 409) {
    throw new BrowserApprovalConsumptionError('Browser approval was already consumed', false)
  }
  if (!response.ok) {
    const retryable =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    throw new BrowserApprovalConsumptionError(
      `Browser approval consumption failed with status ${response.status}`,
      retryable,
    )
  }
}
