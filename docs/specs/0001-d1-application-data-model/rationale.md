# 0001. D1 application data model · decision record

Extracted from the original single file spec when `verify.md` was added; the decision history sections live here, the build spec in `index.md`.

## Context

The agent applies to jobs on your behalf, you approve in Telegram, and you check back on a timer (few hours after submit). Every part of that loop needs shared state: seen listings so no job is offered twice, application records that freeze what was actually submitted, reply linkage so an employer email lands on the right application, and a follow up timer so you get pinged when it is time to check in. Without a decided model, each slice invents its own persistence and later migrations break flows.

The stack is fixed (Hono on Cloudflare Workers, Trigger.dev tasks, single actor: you). Volume is personal: tens of applications per week, so the model optimizes for correctness, dedup, and your readable history rather than throughput. Retention was chosen deliberately: application archives are permanent, transient rows are pruned on configured age.

## Options considered

### Option 1: Raw SQL with wrangler d1 migrations

Hand written SQL files migrated with wrangler, query results typed by hand with record interfaces.

**Pros**: no new dependency; SQL is fully visible; one less build tool chain.
**Cons**: every query result manually typed (against this repo's strict-typing rules), no schema-to-query type safety, easy drift between migration and code.

### Option 2: drizzle-orm with drizzle-kit (chosen)

Schema defined once in TypeScript; drizzle-kit generates migration SQL; queries are type checked against the schema.

**Pros**: typed schema and results by default (matches the enforced typing contract); migrations are generated and reviewable SQL; small, proven library with D1 support.
**Cons**: two new dependencies (drizzle-orm, drizzle-kit) and a codegen step in the workflow.

### Option 3: Snapshot only (no listings table)

Freeze listing text onto each application row; dedup by scanning titles.

**Pros**: one table, no joins, trivial start.
**Cons**: dedup becomes fuzzy text matching; slice 3 (dedup) and reply linkage complicate; listing research (never suggested jobs) has no home.

## Rationale

The stack's hardest rule is end to end typing (no `any`, everything validated at boundaries). Option 1 makes the database the only untyped hole in an otherwise strictly typed codebase, which is exactly the failure style this project forbids. Option 3 trades today's simplicity for fuzzy dedup, the first thing slice 3 depends on. D1 relational tables with UNIQUE constraints give idempotent dedup for free, and drizzle matches the established conventions: generated files, reviewed migrations, no hand rolled typing. Volume is trivial, so the extra codegen step costs nothing at this scale.
