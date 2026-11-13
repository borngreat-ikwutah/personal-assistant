# Verify: data model (D1) · spec 0001 · updated 2026-11-07
_Steps derived from spec 0001 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Manual / DB introspection

- [x] `bunx wrangler d1 migrations apply personal-assistant --local` → `0000_init.sql` applies, then `bunx wrangler d1 execute personal-assistant --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"` → `applications`, `listings`, `replies`, `config` all present → AC-1
- [x] `bunx wrangler d1 execute personal-assistant --local --command "SELECT key, value FROM config ORDER BY key"` → exactly `follow_up_hours` 5, `listing_retention_days` 25, `reply_retention_days` 20 → AC-8
- [x] `bunx wrangler d1 execute personal-assistant --local --command "SELECT sql FROM sqlite_master WHERE name IN ('applications','listings','replies')"` → UNIQUE (`freehire_id`), UNIQUE (`listing_id`), UNIQUE (`email_message_id`), CHECK constraints, and the (`status`,`follow_up_at`) index are in the DDL → AC-1, AC-9

## Commands

- [x] `bunx tsc --noEmit` → zero errors → AC-2
- [x] `bunx hono routes` → the four `/applications` endpoints plus `/` and `/env` are in the inventory with their methods intact → AC-3
- [x] `bunx hono batch - --runtime workerd` (steps below, fixtures: one listing, one `suggested` application whose id is saved from a list step) — regression plus behavior:
      - `GET /` → 200 `Hello Hono!`
      - `GET /env` → 200 with `ok: true`, presence booleans true → regression
      - `GET /applications` without `API_SECRET` → 401 `unauthorized` → AC-3
      - `GET /applications` with header → 200 `{ok,total,limit,offset}` with items carrying joined listing fields → AC-3, AC-9
      - `GET /applications?status=bogus` → 422 `invalid query` → AC-3, AC-7
      - `GET /applications?limit=0` → 422; vary `limit`/`offset` and confirm pagination outputs mirror the inputs → AC-3 (value source: inputs, defaults 20/0)
      - `GET /applications?status=failed` on an empty set → 200 `total: 0` (unknown-to-model query paths stay honest) → AC-3
      - `POST /applications/:id/decision` approve → 200 `approved`; identical repeat call → 409 `conflict` with `currentStatus` (never double advances) → AC-4
      - `POST` decision `skip` while `approved` → 409 with `currentStatus` in the body; the input `decision` value is what picked the target state → AC-4 (value source: input)
      - `POST /applications/:id/retry` while `approved` → 409 → AC-5
      - `PATCH /applications/:id/handled` while `approved` → 409 → AC-6
      - decision on a nonexistent id → 404 `not found`; decision on `abc` id → 422 `invalid id`; `{"decision":"maybe"}` → 422 `invalid decision` → AC-7
- [x] Happy-path rows (seeded one row each in `failed` and `replied` state): retry → 200 `approved`; handled → 200 `handled`; a second `suggested` row skipped → 200 `skipped`; filter `?status=skipped` finds it with listing data → AC-4, AC-5, AC-6
- [x] Database dedup: raw `INSERT INTO applications (listing_id 1, 'suggested', ...)` twice → second fails `UNIQUE constraint failed: applications.listing_id`; `INSERT OR IGNORE` a duplicated `email_message_id` → row count stays 1 → AC-7
- [x] Cleanup: delete the test fixture rows (application rows, listings, replies); config rows remain (3) → last run: fixtures removed, config intact

## Acceptance-criteria coverage
- AC-1: DB introspection step (tables + unique/check/index in DDL)
- AC-2: `tsc --noEmit` + typed drizzle client in `src/lib/db.ts` used by the handlers
- AC-3: 401 step, list shape step, 422 status/limit steps, pagination variation
- AC-4: decision approve/skip, repeat call 409, skip on approved 409, skipped filter
- AC-5: retry 409 loop + failed → approved happy path
- AC-6: handled 409 loop + replied → handled happy path
- AC-7: 422 batch steps + both UNIQUE constraint probes
- AC-8: config rows introspection; first-read seeding in `src/lib/config.ts` (typed, exercised via schema; behavioral lock to come with `/test`)
- AC-9: list items carry `createdAt`/`updatedAt`; index verified in DDL (`follow_up_at` write itself is a later slice per the spec)

_Later slices: `follow_up_at` derivation and reply dedup behavior are exercised when their features land (spec's value sourcing rows 4 and 5)._
