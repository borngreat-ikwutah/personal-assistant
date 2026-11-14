# personal-assistant

## Working Style

- Make the smallest correct change and inspect only files relevant to the task.
- Do not create research, specs, or other documentation unless requested.
- Avoid subagents and broad codebase exploration unless the task genuinely requires them.
- The implementing developer chooses and runs tests appropriate to the change.
- For Hono route changes, comply with the Hono CLI workflow: inspect routes, run relevant batch checks with the workerd runtime, and type-check before completion.

## Project Contract

- This is a strict TypeScript Hono app for Cloudflare Workers, with Trigger.dev background tasks.
- Keep `src/index.ts` as a thin re-export and assemble chained routes in `src/app.ts`.
- Define full paths inside typed route modules and mount them at `/`.
- Keep shared non-route logic in `src/lib/` when reused.
- Use the generated `Env` bindings; do not hand-write or weaken their types.
- Validate external input and preserve the exported `AppType` RPC contract.
