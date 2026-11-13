# 0002. CV ingestion and storage, decision record

## Context

The agent needs a CV for matching and later application submission. The file contains personal data and must not be copied into D1, exposed through a public URL, or silently change underneath an existing application. The Worker can access R2 through a binding, while Trigger.dev tasks run outside Cloudflare and need a separate access path.

## Options considered

### Option 1: Store the CV in D1

Store file bytes or extracted text in the existing database.

Pros: one persistence system and simple task reads.

Cons: poor fit for binary files, larger database rows, more expensive reads, and weaker separation of sensitive file data.

### Option 2: Private R2 with Worker uploads and Trigger.dev S3 reads, chosen

The Worker writes files to a private R2 binding and records immutable metadata in D1. Trigger.dev reads selected objects through R2's S3 compatible API.

Pros: fits the existing Cloudflare stack, separates binary storage from relational metadata, preserves historical versions, and avoids proxying file bytes through the Worker during AI work.

Cons: requires two access configurations and cleanup for partial cross service failures.

### Option 3: Private R2 with all reads proxied through the Worker

Trigger.dev calls an authenticated Worker endpoint, and the Worker reads R2 and streams the bytes back.

Pros: one access boundary and no S3 credentials in Trigger.dev.

Cons: adds Worker bandwidth and latency, makes large file reads depend on the Worker path, and increases coupling between background tasks and the API.

## Rationale

Option 2 best fits the existing split: Cloudflare owns the API and storage binding, while Trigger.dev owns background execution. Immutable D1 metadata and object keys preserve the CV used by historical applications. PDF and DOCX support with raw storage keeps this feature focused; parsing belongs to the later intelligence feature. Permanent retention is the safest first policy because deleting an old version could make an application record impossible to reproduce.

## References

**Project sources**:
- `docs/scope/scope.md`, feature 5 requirements and the deferred multi profile direction
- `docs/specs/0001-d1-application-data-model/index.md`, the existing `payload.cv_version_id` contract
- `wrangler.jsonc`, the existing Cloudflare binding and secret conventions
- `src/trigger/test-generate.ts`, the existing Trigger.dev environment boundary

**Practices and standards**:
- immutable versioning for historical reproducibility
- idempotency keys for retryable mutations
- private object storage for personal data
- least privilege credentials and no secrets in application data
