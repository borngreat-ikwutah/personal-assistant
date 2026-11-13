import { and, eq } from 'drizzle-orm'

import { nowIso, type AppDatabase } from './db'
import { applications, type Application, type ApplicationStatus } from './schema'

/**
 * The one place application status writes go through (spec 0001: "transitions
 * enforced in one transition function"). A write only happens if the row is
 * currently in `from`; the conditional UPDATE guarded on the current status
 * closes the race between two simultaneous callers.
 */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  suggested: ['approved', 'skipped'],
  approved: ['submitted'],
  submitted: ['replied', 'failed'],
  failed: ['approved'],
  replied: ['handled'],
  handled: [],
  skipped: [],
}

export type TransitionResult =
  | { ok: true; application: Application }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'not-in-state'; currentStatus: ApplicationStatus }

export async function applyTransition(
  db: AppDatabase,
  id: number,
  to: ApplicationStatus,
  from: ApplicationStatus,
): Promise<TransitionResult> {
  const [current] = await db
    .select({ status: applications.status })
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1)

  if (current === undefined) {
    return { ok: false, reason: 'not-found' }
  }
  if (!canTransition(from, to)) {
    // A pair the model never permits fails closed, whatever the row says.
    return { ok: false, reason: 'not-in-state', currentStatus: current.status }
  }
  if (current.status !== from) {
    return { ok: false, reason: 'not-in-state', currentStatus: current.status }
  }

  const [updated] = await db
    .update(applications)
    .set({ status: to, updatedAt: nowIso() })
    .where(and(eq(applications.id, id), eq(applications.status, from)))
    .returning()

  // Reachable under a race (another caller moved the row in between); the
  // status guard on the UPDATE is what makes double advancing impossible.
  if (updated === undefined) {
    return { ok: false, reason: 'not-in-state', currentStatus: from }
  }

  return { ok: true, application: updated }
}

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return APPLICATION_TRANSITIONS[from].includes(to)
}
