# 0003. Freehire MCP integration

**Date**: 2026-11-07
**Status**: In Progress

## Summary

This feature gives Trigger.dev tasks a typed way to search Freehire, read job details, and update Freehire tracking. The task runs the local `freehire-mcp` server with `FREEHIRE_TOKEN`, then normalizes job results into the existing D1 `listings` table. Actual employer form submission is deliberately outside this feature because Freehire exposes that as a separate OAuth and permission workflow.

## Requirements

**User stories**:
- As the agent, I want to search Freehire with the user's authenticated account, so I can find relevant jobs without putting credentials in the Worker.
- As the agent, I want each result stored once in D1, so later searches do not offer the same listing repeatedly.
- As the operator, I want the agent to inspect a complete job before matching it, so the match is grounded in the current posting.
- As the operator, I want Freehire tracking to reflect a recorded application later, without confusing that marker with employer submission.

**Acceptance criteria**:
- **AC-1**: The Trigger.dev environment reads `FREEHIRE_TOKEN` as a secret. The token is never stored in D1, Worker variables, source code, task output, or logs.
- **AC-2**: A typed Freehire adapter starts the pinned local `freehire-mcp` server over stdio, authenticates it with `FREEHIRE_TOKEN`, discovers the live tool schema, and closes the MCP session after use.
- **AC-3**: The search task accepts a keyword query, a bounded result limit, and optional live facet filters. It calls the Freehire search tool and returns typed job summaries plus the provider match count and ignored filter values.
- **AC-4**: Search results are normalized and upserted into `listings` by the existing unique `freehire_id`. New rows start as `new`; an existing local listing keeps its local status while source fields and `updated_at` refresh.
- **AC-5**: The adapter can fetch a complete job by its Freehire identifier and returns the source identifier, title, company, description, URL, location, and posting time when the provider supplies them.
- **AC-6**: The adapter exposes explicit tracking operations for save, mark applied, and stage updates, but no search task marks a job applied automatically. A tracking call is idempotent for the same job and stage.
- **AC-7**: Provider authentication failures, invalid tool arguments, rate limits, timeouts, malformed results, and provider outages become typed task errors with bounded retry behavior. Authentication and argument errors do not retry.
- **AC-8**: A repeated search or task retry does not create duplicate D1 listings or duplicate external tracking effects.
- **AC-9**: A Trigger.dev smoke task can perform one authenticated search with the configured token and persist at least one valid result or report a genuine empty result without fabricating data.
- **AC-10**: No Worker HTTP endpoint receives or proxies the Freehire token. Later application and Telegram features call the typed adapter or task, not the provider directly.

## Decision

Use the local `freehire-mcp` npm server as the provider boundary inside Trigger.dev. A small MCP client module owns process startup, session initialization, tool discovery, typed argument construction, result parsing, timeout handling, and shutdown. `FREEHIRE_TOKEN` is injected only into the child process environment from Trigger.dev secrets.

The integration has two layers. The provider adapter performs one Freehire operation and returns typed provider data. The search task orchestrates facets, search, normalization, and D1 upserts. D1 remains the local source of truth for listing identity and local status. Provider tracking is an explicit side effect, separate from local application state.

**Implementation skills**: `trigger-authoring-tasks` (`trigger.dev`, `.agents/skills/trigger-authoring-tasks/`) · `hono` (`hono`, `.agents/skills/hono/`) only if a later route exposes task triggering

## Feature design

**Data model sketch**:

No new tables are required. The existing `listings` table is the local catalog:

- `freehire_id` is the stable provider identifier and remains unique.
- `url`, `title`, `company`, `description`, `posted_at`, and `location` are refreshed from provider data when present.
- `status` remains a local state and is not overwritten by a later search.
- `first_seen_at` is written only when the listing is first inserted.
- `updated_at` is refreshed after a successful provider observation.

The search result is transient task data. It is not stored as a second provider response table. Later application rows reference `listings.id` through the existing schema.

**State transitions**:

Local listing state remains governed by spec 0001:

```text
new → suggested → skipped
new → suggested → applied
```

Provider tracking is separate:

```text
untracked → saved
untracked → applied marker
applied marker → preparing → applied → screening → responded → interview → offer → accepted
```

The integration never advances the local application state machine and never treats a provider applied marker as employer submission.

**API surface**:

These are internal Trigger.dev interfaces, not public Worker routes.

| Function or task | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `searchFreehireTask` | Trigger task | `query` required string, `limit` 1 to 50, optional facet filters | provider count, ignored filters, typed summaries, inserted and updated listing counts | `FREEHIRE_TOKEN` in Trigger.dev | auth failure, timeout, rate limit, malformed result |
| `freehireClient.facets` | MCP tool call | optional facet group | live filter names and values | local MCP token | auth failure, provider outage |
| `freehireClient.search` | MCP tool call | query, limit, live filters | typed job summaries and full descriptions when supplied | local MCP token | invalid filter, rate limit, timeout |
| `freehireClient.job` | MCP tool call | stable Freehire job identifier | complete normalized job detail | local MCP token | not found, timeout, malformed result |
| `freehireClient.track` | MCP tool call | job identifier, operation, optional stage or note | provider tracking result and provider status | local MCP token | permission failure, conflict, timeout |

**Value sourcing**:

| Action | Value produced or displayed | Source |
|---|---|---|
| search task | query | Trigger task payload |
| search task | result limit | Trigger task payload, bounded to 50 |
| search task | valid facet filters | `facets` tool response, never invented locally |
| search task | ignored filters | Freehire search response |
| normalized listing | `freehire_id` | Freehire job identifier or stable slug |
| normalized listing | title, company, description, URL, location, posted time | Freehire search or job response fields |
| normalized listing | local listing id | D1 generated `listings.id` |
| normalized listing | local status | existing D1 row, or schema default `new` for an insert |
| normalized listing | first seen time | Worker or task generated ISO timestamp only on insert |
| normalized listing | updated time | Worker or task generated ISO timestamp after a successful observation |
| task result | inserted and updated counts | D1 insert and update outcomes |
| tracking result | provider tracking state | Freehire tracking tool response |

**Key invariants**:
- Every provider job maps to one D1 listing through unique `freehire_id`.
- Search retries are safe because D1 upsert preserves identity and local status.
- Source refresh never overwrites local status, application relationships, or historical application payloads.
- Search never performs an external tracking mutation.
- Tracking mutations require an explicit operation and job identifier and can be retried safely.
- Provider output is parsed at the boundary and unknown fields are ignored rather than copied into D1.
- The token exists only in Trigger.dev process environment and is never included in task output.

**Security model**:

Only Trigger.dev tasks can use the Freehire credential. The Worker does not accept the token and public HTTP routes do not proxy MCP calls. Logs may include task id, provider operation, job identifier, status code, and timing, but not the token, authorization headers, full MCP payloads, or full job descriptions when they contain personal data. Tracking operations are single actor operations and must be called only by later approved application flows.

**Configuration required**:
- `FREEHIRE_TOKEN`: Trigger.dev secret containing the Freehire API key.
- `FREEHIRE_MCP_VERSION`: pinned `freehire-mcp` package version used by Trigger.dev builds.
- `FREEHIRE_OPERATION_TIMEOUT_MS`: optional task configuration, default 30 seconds per provider call.

**Critical test scenarios**:
- Happy path: authenticated task discovers facets, searches for `golang`, normalizes results, and upserts listings, verifies **AC-2**, **AC-3**, **AC-4**, **AC-9**.
- Retry path: run the same search twice and confirm stable listing count, preserved local status, and no duplicate rows, verifies **AC-4**, **AC-8**.
- Provider failure: invalid token and provider timeout return typed non leaking task errors with the documented retry policy, verifies **AC-1**, **AC-7**.
- Detail path: fetch a stored listing by its Freehire identifier and confirm fields map to the existing listing shape, verifies **AC-5**.
- Tracking path: explicitly mark a job applied or move its provider stage and confirm no local application is submitted automatically, verifies **AC-6**, **AC-10**.

## Rationale

Reasoning and options are in [rationale.md](rationale.md).

## Build plan

Tracer Bullet: first prove one real authenticated search through the MCP process into one D1 listing upsert. Then add detail reads, tracking operations, retries, and task level verification.

1. [x] Add the pinned `freehire-mcp` and MCP client dependencies, Trigger.dev secret configuration, and a provider adapter with session lifecycle and typed result parsing, satisfies **AC-1**, **AC-2**, **AC-7**, **AC-10**.
2. [x] Add the search task with facets, bounded inputs, normalization, and idempotent D1 upserts against `listings`, satisfies **AC-3**, **AC-4**, **AC-8**, **AC-9**.
3. [x] Add job detail and explicit tracking helpers with safe retry behavior, satisfies **AC-5**, **AC-6**, **AC-10**.
4. [ ] Run an authenticated task smoke test, mocked provider failure tests, duplicate search checks, and TypeScript validation, satisfies **AC-1** through **AC-10**. Mocked failures, duplicate persistence, TypeScript, Hono, and Trigger bundle checks pass; the authenticated search awaits configured production secrets.

## Consequences

**Positive**:
- The provider boundary is isolated from application logic and can be replaced without rewriting D1 flows.
- Trigger.dev owns credential use and long running provider calls.
- Existing uniqueness and status constraints make repeated search safe.
- The system does not pretend a tracking marker is a submitted application.

**Negative / tradeoffs**:
- A local MCP child process adds startup and packaging complexity to each task.
- The task depends on the availability and version of an external npm package.
- Provider result schemas can change, so boundary parsing and smoke checks must remain current.
- Real employer submission still needs a separate OAuth design and cannot be completed with this token alone.

**Neutral**:
- No new D1 migration is expected for this feature.
- Search and tracking are task level capabilities. A future Telegram command or schedule will trigger them.

## Follow-up

- [ ] Design Feature 7 for real employer submission through Freehire's OAuth permission workflow.
- [x] Pin the exact `freehire-mcp` package version during implementation and record its tool schema fixture.
- [ ] Decide whether later scheduled searches use the task directly or a shared search queue.
