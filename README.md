To install dependencies:
```sh
bun install
```

To run:
```sh
bun run dev
```

open http://localhost:3000

To run locally on Cloudflare Workers runtime:
```sh
bun run dev:cf
```

open http://localhost:8787

To deploy to Cloudflare Workers:
```sh
bun run deploy
```

## Environment

- `wrangler.jsonc` `"vars"` — non-secret public vars, committed and auto-deployed.
- Secrets — never in files; set on the deployed worker: `bunx wrangler secret put NAME` (e.g. `API_SECRET`).
- Local runtime env — `.dev.vars` (read automatically by `wrangler dev`); `.env` mirrors it for convention. Both are gitignored.
- See `.env.example` for the documented shape. `GET /env` shows `APP_NAME` and whether `API_SECRET` is set (secrets are never echoed).
