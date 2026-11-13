# 0003. Freehire MCP integration, decision record

## Context

The agent needs reliable job discovery before it can match jobs, ask for approval, or submit applications. Freehire provides a local MCP server that uses the same account token as the CLI. The existing database already has a unique `freehire_id` and the fields needed to preserve a listing snapshot. The project runs background work in Trigger.dev, not in the Worker request path.

> ⚠️ Premise note: The original scope grouped listing search and application submission together. Freehire's token based `apply` operation records a job as applied, but employer submission requires a separate OAuth flow and explicit permission. This spec focuses on discovery and tracking. Feature 7 should design and implement real employer submission rather than pretending the tracking marker is submission.

The agent needs authenticated job discovery and a stable local listing catalog. Freehire offers a CLI and a local MCP server over the same API. The existing project puts long running external calls in Trigger.dev and already stores provider identifiers in D1. The supplied credential is an API key suitable for the local MCP path.

## Options considered

### Option 1: Shell out to the Freehire CLI for every operation

Trigger.dev would run `freehire search`, `freehire job`, and tracking commands with JSON output.

Pros: matches the operator's known command and is quick to test manually.

Cons: parsing command output and installing a platform binary inside Trigger.dev couples application code to a CLI process and makes tool discovery less explicit.

### Option 2: Run the local `freehire-mcp` server and use an MCP client, chosen

Trigger.dev starts the pinned npm server with `FREEHIRE_TOKEN` and calls its tools through the MCP protocol.

Pros: matches the feature goal, keeps provider operations typed at one adapter boundary, uses the same token, and exposes live tool schemas.

Cons: adds an MCP client and child process lifecycle to the task, and the package must be pinned and smoke tested.

### Option 3: Call the Freehire HTTP API directly

Trigger.dev would implement a bespoke REST client over Freehire endpoints.

Pros: fewer process boundaries and direct control over HTTP retries.

Cons: duplicates provider contract knowledge, risks drifting from the public MCP and CLI surface, and requires adopting undocumented or separately maintained API details.

## Rationale

Option 2 is the best fit for the requested integration and the existing Trigger.dev boundary. It preserves the user's working credential flow while keeping Freehire specific schemas out of the D1 and application layers. The scope is intentionally narrowed because current Freehire documentation says the token based `apply` operation marks a job applied, while actual employer submission requires OAuth and explicit permission.

## References

**Project sources**:
- `docs/scope/scope.md`, Feature 6 and the later thin apply loop
- `docs/specs/0001-d1-application-data-model/index.md`, existing `listings` identity and status contract
- `src/trigger/`, current Trigger.dev task boundary
- `docs/specs/0002-cv-ingestion-storage/index.md`, current Trigger.dev secret and external integration conventions

**Practices and standards**:
- idempotent upsert for repeated provider reads
- boundary validation for external responses
- least privilege secret handling
- explicit separation of provider tracking from local application state

**Links**:
- Freehire CLI and MCP overview: https://freehire.me/cli
- Freehire MCP setup and account capabilities: https://freehire.me/mcp
- Freehire MCP source and tool list: https://github.com/strelov1/freehire-mcp
- Freehire CLI source: https://github.com/strelov1/freehire-cli
