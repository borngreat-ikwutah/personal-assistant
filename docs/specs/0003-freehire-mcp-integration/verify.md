# Verify: Freehire MCP integration

## Provider and task checks

- [ ] Trigger.dev has `FREEHIRE_TOKEN` configured as a secret and the value never appears in logs or task output, AC-1.
- [ ] The task starts the pinned local `freehire-mcp` server, initializes an MCP session, discovers tools, and shuts the process down, AC-2.
- [ ] An authenticated search for `golang` with a bounded limit returns a typed result or an honest empty result, AC-3 and AC-9.
- [ ] Live facet values are used for filters, and unknown or ignored values are returned from the provider response rather than invented locally, AC-3.

## D1 checks

- [ ] One result creates one `listings` row with the source identifier and mapped fields, AC-4.
- [ ] Running the same task twice does not create duplicate rows and preserves any local listing status, AC-4 and AC-8.
- [ ] A job detail lookup maps the provider response to the existing listing fields, AC-5.

## Failure and security checks

- [ ] Invalid credentials fail without retries that could lock the account and without exposing the token, AC-1 and AC-7.
- [ ] Provider timeout and rate limit behavior follows the bounded retry policy, AC-7.
- [ ] Explicit tracking marks a provider job without advancing a local application state or claiming employer submission, AC-6 and AC-10.
- [ ] TypeScript and Trigger.dev build checks pass, AC-2 and AC-7.
