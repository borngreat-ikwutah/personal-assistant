# 0001. D1 application data model

**Date**: 2026-11-07
**Status**: Accepted

## Summary

This spec records the database design for the application agent: four tables in D1 (Cloudflare's SQLite database) holding job listings, applications, replies, and configuration knobs. Code talks to it through drizzle (a typed query layer) with migrations produced by drizzle-kit. A small guarded HTTP surface lets you list applications and move them through their states from the terminal as well as from Telegram buttons. Nothing here submits jobs or sends alerts; those slices build on these records.

## Requirements

**User stories**:
- As the operator (you), I want every Freehire listing stored once, so the agent never suggests or applies to the same job twice.
- As the operator, I want one application record per listing that walks suggested to handled, so a job's full history lives on one row.
- As the operator, I want to list and move applications through their states with `curl`, so I can drive the agent without the Telegram UI.
- As the operator, I want submitted applications to carry a follow up time, so the timer slice knows when to ping me.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: A migration creates four tables: `listings`, `applications`, `replies`, `config`, with UNIQUE (`freehire_id`) on listings, UNIQUE (`listing_id`) on applications, UNIQUE (`email_message_id`) on replies, and CHECK constraints limiting `status` values to the documented sets.
- **AC-2**: The data layer is typed end to end (a typed drizzle client on the D1 binding) and usable from both route handlers and Trigger.dev tasks with zero untyped query results.
- **AC-3**: `GET /applications?status=<status>&limit=&offset=` returns matching application rows with their listing data, paginated (defaults limit 20, offset 0), and rejects unknown status values with 422.
- **AC-4**: `POST /applications/:id/decision` with `decision: approve | skip` moves an application from `suggested` to `approved` or `skipped`; calling it on an application already past that point is a 409, and a repeated identical successful call is a no-op (idempotent accept fails closed as 409, never double advances).
- **AC-5**: `POST /applications/:id/retry` moves a `failed` application back to `approved`; calling it on a non `failed` row returns 409.
- **AC-6**: `PATCH /applications/:id/handled` moves a `replied` application to `handled`; calling it on any other state returns 409.
- **AC-7**: Writes that violate the model are rejected: an unknown status value (422), a second application row for a listing (409 via the unique constraint), a duplicate reply email (unknown to callers, silently deduped via UNIQUE).
- **AC-8**: On first use, `config` rows exist for `follow_up_hours` = 5, `reply_retention_days` = 20, `listing_retention_days` = 25; they are read by key from any task or route.
- **AC-9**: Every row carries `created_at` and `updated_at`; a submitted application can be given `follow_up_at` derived from `config.follow_up_hours` plus the submit time, and the applications index on (`status`, `follow_up_at`) serves that timer scan.

## Decision

**Chosen option**: Option 2: drizzle-orm with drizzle-kit over D1.

One typed data layer for every slice, with database enforced dedup and a generated, reviewable migration. The engineer approved adding the two dependencies for this feature.

## Feature design

**Data model sketch**:

`listings`
- `id` INTEGER PK autoincrement
- `freehire_id` TEXT NOT NULL, UNIQUE
- `url` TEXT, `title` TEXT, `company` TEXT, `description` TEXT
- `posted_at` (nullable), `location` (nullable)
- `status` TEXT NOT NULL default `new` CHECK (`new | suggested | skipped | applied`)
- `first_seen_at`, `updated_at` NOT NULL

`applications`
- `id` INTEGER PK autoincrement
- `listing_id` INTEGER NOT NULL UNIQUE → `listings.id` (one application row per listing, retries stay on the row)
- `status` TEXT NOT NULL CHECK (`suggested | approved | submitted | replied | handled | skipped | failed`)
- `match_score` REAL, `match_reason` TEXT, `matched_at` (nullable until matched)
- `payload` JSON (nullable until approval): frozen cover note text, `cv_version_id` (nullable, filled by the CV storage spec), submitted message body, attempt timestamps
- `telegram_message_id` (nullable), `follow_up_at` (nullable), `followed_up_at` (nullable)
- `last_submitted_at` (nullable)
- `created_at`, `updated_at` NOT NULL
- INDEX (`status`, `follow_up_at`) for the timer scan

`replies`
- `id` INTEGER PK autoincrement
- `application_id` INTEGER nullable → `applications.id` (nullable: unmatched emails persist)
- `email_message_id` TEXT NOT NULL UNIQUE (email Message-ID header)
- `from_addr`, `subject`, `snippet`, `raw_ref`
- `received_at`, `alerted_at` (nullable), `created_at` NOT NULL

`config`
- `key` TEXT PK, `value` TEXT

**State transitions** (application): `suggested → approved → submitted → replied → handled`; from `suggested` also `skipped` (terminal until you re decide via a future action, not this feature); `submitted → failed` (submission error), `failed → approved` on retry. Transitions enforced in one transition function; `replied` and `follow_up_at` writes are performed by later slices, all other states and writes by this feature's endpoints and Telegram callbacks.

**API surface**:
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| /applications | GET | `status`: enum (opt), `limit`, `offset`: int (opt) | application rows with listing data, total count | `API_SECRET` header | 422 unknown status |
| /applications/:id/decision | POST | `decision`: `approve | skip` (req) | id, new status | `API_SECRET` header | 409 not in suggested |
| /applications/:id/retry | POST | none | id, new status | `API_SECRET` header | 409 not in failed |
| /applications/:id/handled | PATCH | none | id, new status | `API_SECRET` header | 409 not in replied |

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| list applications | rows + listing fields | DB columns, joined listing |
| list applications | pagination | `limit` / `offset` inputs, defaults 20 / 0 |
| decision / retry / handled | new status | input `decision`, or fixed target state of the endpoint |
| timer (later slice) | `follow_up_at` | derived: `config.follow_up_hours` + submit time |
| reply dedup (later slice) | match/unmatched | `email_message_id` UNIQUE + nullable `application_id` |
| retention (later slice) | prunable set | policy: applications never; replies pruned once linked application `handled` and older than `reply_retention_days`; `new` state listings older than `listing_retention_days` |

**Key invariants**:
- One application row ever per `freehire_id` (via listings UNIQUE + applications UNIQUE listing link).
- Status values are closed sets, enforced by CHECK and by the single transition function.
- Applications and their frozen payloads are never pruned.
- No secrets, tokens, or CV binary data in the database (CV lives in R2 per its own spec; references only).

**Security model**:
Single actor. Every endpoint requires the `API_SECRET` header (same secret class already required in `wrangler.jsonc`), checked by a shared hono middleware; requests without it get 401. No roles, no multi tenancy. Cover notes and listing text are stored as plain rows; the database holds no credentials. CV text is PII and is deliberately referenced (R2 id) rather than copied into D1.

**Configuration required**:
- D1 `database_id`: created once, bound as `DB` in `wrangler.jsonc` and typed by `bun run cf-typegen`.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Happy path: migration applies, endpoints seed flows locally, a decision moves a row and the list reflects it, verifies **AC-3**, **AC-4**
- Failure case: approve twice, retry a submitted row, handled on a suggested row, each 409; second application row for one listing rejected, verifies **AC-4**, **AC-5**, **AC-6**, **AC-7**
- Auth/permission: request without `API_SECRET` header is 401 on every endpoint, verifies **AC-3** (headers first)
- First run: fresh DB has the three config rows with the exact defaults, verifies **AC-8**

## Build plan

Tracer Bullet: land the whole real model in one migration (the model is the feature), then one thin live thread through the endpoints, then types and flows thicken only where the endpoints demand it.

1. [x] Create the D1 database, add the `DB` binding, re-run `cf-typegen`; write migration 0000 with all four tables, indexes, and checks, satisfies **AC-1**, **AC-9**
2. [x] Typed drizzle client module under `src/lib/` (pool of one binding; importable by routes and Trigger.dev tasks; `updated_at` maintained in code), satisfies **AC-2**
3. [x] Config seeding on first read plus defaults (5 / 20 / 25), satisfies **AC-8**
4. [x] Endpoints: list (paginated, filtered, 422s) then decision, retry, handled transitions via one shared transition function and `API_SECRET` middleware; error paths typed (409 / 422 / 401), satisfies **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-7**
5. [x] Verify per the API Route Verification Rule: `bunx hono routes`, `bunx hono batch` expect steps covering every route including regression steps for `/` and `/env`, then `bunx tsc --noEmit` green, satisfies **AC-3** through **AC-9**

## Consequences

**Positive**:
- Every later slice (dedup, replies, timer) writes into one decided, typed schema.
- Database constraints make double apply and duplicate replies structurally impossible, not just UI guarded.
- One application per listing keeps the full job history readable in one row.

**Negative / tradeoffs**:
- Two new dependencies and a migration codegen step now live in the workflow.
- Follow up timer detection is scan based (index on status and time), not push based; a later scheduled slice owns the scan task.
- Retention pruning has no owner until slice 3 lands the scheduled task; tables grow slightly in the interim (harmless at this volume).

**Neutral**:
- Cloudflare Email Routing and R2 specs must reference `replies.email_message_id` and the `applications.payload.cv_version_id` contract they will fill.
- `follow_up_hours`, once written as a config row, changes behavior for all future submits.

## Follow-up

- [ ] Retention pruning task and schedule: designed with slice 3 (scheduled job searches), implementing the policy documented here
- [ ] After this feature's commit: record the per feature commit convention in root `AGENTS.md` (via `/sync` on feature completion)
