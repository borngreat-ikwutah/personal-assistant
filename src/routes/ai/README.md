# routes/ai/

Home for AI assistant API slices (LLM-backed endpoints, assistants, chats).

Current contents: none yet. The first AI route lands here following
`src/routes/messaging/telegram.ts` as the pattern, per the AGENTS.md
structure contract (one module per slice, chained `Hono<{ Bindings: Env }>`,
full final paths inside the module, mounted via one `app.route('/', …)` line
in `src/app.ts`).

This folder was created deliberately as the namespace for incoming AI work —
it is not a bucket for uncategorized endpoints.
