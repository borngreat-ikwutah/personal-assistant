# Scope: personal-assistant (job application agent)

A personal agent that finds job listings from Freehire, matches them against your CV, and applies on your behalf after you approve each one in Telegram. It watches your email for employer replies and alerts you so you can handle the conversation yourself. Built on the existing Hono + Cloudflare Workers + Trigger.dev backend.

**Build approach:** Tracer Bullet (prove the whole pipe works end to end with one real thin thread, then thicken one segment at a time).
**Workflow:** Beta (after each build: `/check verify`, then `/test`). The project default level of rigor. `/architect` is the recommended first stop for a feature with a real decision, but skippable when you already know the build. Any feature can carry its own tag (e.g. `· GA`) to do more or less.

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Worker skeleton & typed routes | Before | existing |
| 2 | Telegram bot webhook | Before | existing |
| 3 | Trigger.dev & AI task plumbing | Before | existing |
| 4 | Data model (D1) | Foundation | done |
| 5 | CV ingestion & storage (R2) | Foundation | in-progress |
| 6 | Freehire MCP integration | Foundation | planned |
| 7 | Thin apply loop (walking skeleton) | Slice 1 | planned |
| 8 | Reply capture & notifications | Slice 2 | planned |
| 9 | Scheduled job searches | Slice 3 | planned |
| 10 | Application intelligence | Slice 4 | planned |

## Before (existing backend, enrolled for context)

### 1. Worker skeleton & typed routes · existing
Hono on Cloudflare Workers, chained routes with `AppType` export, env wiring and `GET /env`. code in `src/app.ts`, `src/routes/`

### 2. Telegram bot webhook · existing
Telegram webhook with secret token auth and bot plumbing; currently echo only. code in `src/routes/messaging/telegram.ts`

### 3. Trigger.dev & AI task plumbing · existing
Trigger.dev configured with tasks in `src/trigger/`, AI SDK call against Groq, polled from a worker route. code in `src/trigger/`, `src/routes/ai/`

## Foundation

### 4. Data model (D1) · done
The records the whole agent runs on: applications (job, listing, match result, status, submitted at), approvals/decisions, and tracked reply threads. One actor: you.
**Done when:** D1 schema is live and typed, and every state write the agent does later (search, match, approve, submit, reply seen) has a home without a breaking migration.
- [x] Design it (spec): `/architect data model (D1)`
- [x] Build it: `/develop data model (D1)`
   - [x] Migration (four tables) + D1 binding + typed drizzle client + config seeding, satisfies AC-1, AC-2, AC-8, AC-9
   - [x] Endpoints: list, decision, retry, handled with transitions and guard, satisfies AC-3, AC-4, AC-5, AC-6, AC-7
   - [x] Route verification pass (`hono routes`, `hono batch`, `tsc --noEmit`), satisfies AC-3 through AC-9
- [x] Verify it: `/check verify data model (D1)`
- [ ] Test it: `/test data model (D1)` — skipped by your call (2026-11-07)
- [ ] Commit the feature when done (one commit for this feature, per your convention)
Spec [0001](../specs/0001-d1-application-data-model/index.md). code in `src/lib/schema.ts`, `src/lib/db.ts`, `src/lib/config.ts`, `src/lib/applications.ts`, `src/routes/applications.ts`, `migrations/0000_init.sql`

### 5. CV ingestion & storage (R2) · in-progress
Your CV lives in R2 and the agent can read it (raw, and later its structured profile). One upload path, versioned so a re-upload does not corrupt past application records.
**Done when:** you can put a CV in and any agent task (a Trigger.dev task, not just a route) can fetch the right version of it, including from the AI SDK matching run.
- [x] Design it (spec): `/architect CV ingestion & storage (R2)`
Spec [0002](../specs/0002-cv-ingestion-storage/index.md). code in `src/routes/cv.ts`, `src/lib/cv.ts`, `src/lib/schema.ts`, `src/trigger/`
- [ ] Build it: `/develop CV ingestion & storage (R2)`
   - [x] R2 binding, generated types, and D1 version metadata migration, satisfies AC-1, AC-4, AC-9
   - [x] Authenticated multipart upload with validation, digest, private object storage, current pointer, and cleanup, satisfies AC-2, AC-3, AC-8, AC-10
   - [x] Idempotent metadata and version read endpoints, satisfies AC-5, AC-6, AC-10
   - [ ] Trigger.dev direct R2 read helper and task verification, satisfies AC-7
- [ ] Verify it: `/check verify CV ingestion & storage (R2)`
- [ ] Test it: `/test CV ingestion & storage (R2)`

### 6. Freehire MCP integration · needs a decision
The MCP client through which the agent retrieves job listings (search, and the apply flow it will submit through, per your access). Runs inside Trigger.dev tasks.
**Done when:** an agent task can list jobs from Freehire for real (with your credentials), including an application being submitted through Freehire's apply flow.
- [ ] Design it (spec): `/architect Freehire MCP integration`

## Slice 1: Thin apply loop (walking skeleton)

### 7. Thin apply loop · needs a decision
One command in Telegram ("find jobs") triggers a task: fetch a few Freehire listings, match one against your CV, message it to you with approve or skip inline buttons, and on approval actually submit through Freehire and record it in D1. Every layer, real, just narrow; no schedule and no email yet.
**Done when:** a single approved application travels CV → match → Telegram approval → Freehire submission → D1 record, end to end, and the Telegram message confirms submission.
- [ ] Design it (spec): `/architect thin apply loop`

## Slice 2: Reply capture & notifications

### 8. Reply capture & notifications · needs a decision
Cloudflare Email Routing receives employer mail on a dedicated address; the Worker records the reply and, when it matches a submitted application, alerts you in Telegram with the sender and subject so you can open your inbox and handle it.
**Done when:** a reply email to an alerting-capable tracked application reaches your existing inbox, and you get a Telegram alert naming the job with the reply linked or quoted.
- [ ] Design it (spec): `/architect reply capture & notifications`

## Slice 3: Scheduled job searches

### 9. Scheduled job searches · needs a decision
A Trigger.dev schedule runs the search and match on a cadence, deduplicates listings against everything seen before, and messages you new matches in Telegram (the same approval flow as Slice 1). On demand still works beside it.
**Done when:** new matching jobs arrive in Telegram on their own without you asking, and no listing is ever offered to you twice.
- [ ] Design it (spec): `/architect scheduled job searches`

## Slice 4: Application intelligence

### 10. Application intelligence · needs a decision
Before approval you can see (and regenerate) the cover note with proper English and any CV tailoring the agent proposes; the approved text is exactly what gets submitted through Freehire.
**Done when:** each approval shows the drafted cover note and any tailored attachment, you can regenerate or edit, and the submitted record stores what was actually sent.
- [ ] Design it (spec): `/architect application intelligence`

## Deferred
Out of scope for the current build pass, kept so the plan stays honest.
- **Application history & stats**: dashboard or command to review past applications and outcomes- **Posting notifications**: follow up with an employer when no reply arrives
- **Per job match threshold tuning**: stricter or looser matching gates and keyword weights
- **Fallback job sources**: a second source if Freehire is down or a category gap
- **Multi CV profiles**: tailored CV variants per role type beyond per job tailoring
- **Retention pruning schedule**: reply and stale listing cleanup task (from spec 0001), designed with scheduled job searches
- **Per feature commit convention** (from spec 0001): recorded in `AGENTS.md` via `/sync` when this feature completes

## Legend

**The decision box.** Every feature carries exactly one, the sub-task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally, `Decide the stack (spec)` on Stack & architecture), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**:
- `planned` · needs a decision → one box: `Design it (spec): /architect <feature>`
- `in-progress` → `/architect` ticks the design box and links the spec; `/develop` fills `code in`
- `done` you decide when the tier's last stage ran (Beta → after `/test`); `/sync` reconciles
- `existing` predates the workflow; `/develop` and `/sync` never touch it
- **Next step** = the first unticked box (always a command or a tracked milestone).
- **Workflow** (header line) is the project default: **Beta** = after `/develop`, `/check verify` then `/test`.
