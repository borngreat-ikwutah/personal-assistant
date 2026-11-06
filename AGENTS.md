# AGENTS.md — personal-assistant

## API Route Verification Rule

- Every API route change must be verified with the Hono CLI (`@hono/cli`, via the installed `hono` skill) before shipping:
  - `bunx hono routes` — confirm the route inventory is complete and matches the source.
  - `bunx hono batch -` (with `--runtime workerd` for this wrangler project) — send requests with `expect` on status/body, including a step for each pre-existing route to protect against regressions; iterate until `"failed": 0`.
  - `bunx tsc --noEmit` — keep the build green.
- Never present a route change as done, and never deploy it, without this verification passing in the last run.
