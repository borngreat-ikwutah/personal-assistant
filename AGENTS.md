# AGENTS.md — personal-assistant

## API Route Verification Rule

- Every API route change must be verified with the Hono CLI (`@hono/cli`, via the installed `hono` skill) before shipping:
  - `bunx hono routes` — confirm the route inventory is complete and matches the source.
  - `bunx hono batch -` (with `--runtime workerd` for this wrangler project) — send requests with `expect` on status/body, including a step for each pre-existing route to protect against regressions; iterate until `"failed": 0`.
  - `bunx tsc --noEmit` — keep the build green.
- Never present a route change as done, and never deploy it, without this verification passing in the last run.

## Project Structure (backend wiring contract)

```
src/
  index.ts        → wrangler entrypoint; thin re-export of ./app only
  app.ts          → creates the Hono instance, mounts route modules in one chained
                    `routes`, declares notFound/onError, exports AppType + default
  routes/*.ts     → one module per slice; each exports a chained `new Hono<{ Bindings: Env }>()`
  routes/messaging/     → messaging integrations (e.g. Telegram webhook)
  routes/ai/            → AI assistant endpoints (namespace reserved; README of record)
```

- Route modules declare their **full final paths** internally and are mounted via `app.route('/', module)` — do not split a path between the mount point and the module, it breaks the RPC type contract.
- New slices follow this file layout: add `src/routes/<name>.ts` (or, for messaging/AI slices, `src/routes/messaging/<name>.ts` / `src/routes/ai/<name>.ts` — categorize by slice, never drop new modules in bare `src/routes/*` for those categories) and one `.route('/', …)` line in `app.ts`. Never register a handler directly in `app.ts`, and never let `index.ts` grow beyond the re-export.
- Shared non-route logic (Telegram bot calls, external API clients) never lives inside a route module beyond the call site of a single module — extract to a module-scoped function first, promote to `src/lib/` when a second module needs it.

## Hono Strictness Rules (no lazy typing)

These rules are hard requirements, not preferences. Contravention is failure.

1. **Use the hono skills.** For any work touching `hono` code, load the relevant installed skill (`hono`, `hono-jsx`) and follow it. Do not guess APIs from memory.
2. **Typed app instance.** The app must be constructed with its environment generic: `new Hono<{ Bindings: Env }>()`. `Env` comes from `bun run cf-typegen` (`wrangler types`) — never hand-write binding types, never re-introduce `@cloudflare/workers-types`. Rerun typegen after every change to `wrangler.jsonc` and commit the regenerated `worker-configuration.d.ts`.
3. **Chained routes = typed contract.** Route definitions must be chained on a single variable that is exported as the public contract:
   - `const routes = app.route(...)...` (in `src/app.ts`) and export `type AppType = typeof routes` (re-exported from `src/index.ts`).
   - This is what makes `hono/client`'s `hc<AppType>` produce typed request/response bindings. Unchained route declarations silently lose type inference — they are forbidden.
4. **No untyped JSON responses.** `c.json(...)` may only be used where the whole app type is exported (rule 3). When adding handlers outside the chain, use `factory.createHandlers` from `hono/factory` so handlers stay typed (a patched factory-created pattern is acceptable; raw dictionaries are not).
5. **Validate all external input** at boundaries with `zValidator`/`sValidator` — never `any`-cast parsed bodies; use `c.req.valid(...)`. A request body/query accepted without a schema check fails review even if tests pass.
6. **`strict: true` stays.** The tsconfig's `strict` flag, `lib: ["ES2023"]`, `types: []`, and `worker-configuration.d.ts` are the typing contract for this project — do not weaken or add overlapping type sources.
7. **Verify the type contract alongside routes.** In addition to the API Route Verification Rule, whenever route or binding types change: (a) `bunx tsc --noEmit` must pass with zero errors relating to route/env types, and (b) update any `expect` steps in `hono batch` that assert response shape so they check the real (typed) response, not a loosened match.

