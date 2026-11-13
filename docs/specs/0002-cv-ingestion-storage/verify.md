# Verify: CV ingestion and storage

## Route and type checks

- [ ] `bunx hono routes` shows `POST /cv`, `GET /cv`, and `GET /cv/:versionId`, plus every pre existing route.
- [ ] `bunx hono batch - --runtime workerd` verifies the unauthenticated 401 responses, invalid upload responses, metadata response shapes, pagination, missing version behavior, and all pre existing route regressions.
- [ ] `bunx tsc --noEmit` passes with the generated R2 binding types and no weakened compiler settings.

## Storage checks

- [ ] A fresh local D1 database applies the CV migration and contains the singleton document and version metadata tables.
- [ ] A valid PDF and DOCX upload creates one private R2 object and one metadata row, and the second upload becomes current without changing the first row.
- [ ] Unsupported MIME types, unsupported extensions, empty files, and files over 10 MB are rejected before a durable version is created.
- [ ] Repeating an upload with the same `Idempotency-Key` returns the original version and leaves the row and object counts unchanged.
- [ ] A failed metadata write does not advance the current pointer and attempts R2 cleanup.
- [ ] Version metadata contains no file bytes, secrets, or public URL.

## Task access checks

- [ ] A Trigger.dev task reads the selected object through the configured R2 S3 endpoint and proves the bytes match the stored SHA 256 digest.
- [ ] Missing or invalid Trigger.dev R2 credentials fail without exposing credentials or file contents in logs.

## Acceptance criteria coverage

- AC-1: binding and migration checks
- AC-2 through AC-6: route and upload behavior checks
- AC-7: Trigger.dev task access checks
- AC-8: partial failure checks
- AC-9: retention and no deletion checks
- AC-10: validation, authentication, and error shape checks
