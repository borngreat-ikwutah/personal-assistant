import { and, desc, eq, sql } from 'drizzle-orm'

import { createDb, nowIso, type AppDatabase } from './db'
import { cvDocuments, cvVersions, type CvVersion } from './schema'

export const CV_DOCUMENT_ID = 'primary'
export const MAX_CV_BYTES = 10 * 1024 * 1024

export const CV_CONTENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const

export type CvContentType = (typeof CV_CONTENT_TYPES)[keyof typeof CV_CONTENT_TYPES]

export type CvMetadata = Pick<
  CvVersion,
  'id' | 'originalFilename' | 'contentType' | 'sizeBytes' | 'sha256' | 'createdAt'
> & { current: boolean }

export function isCvContentType(value: string): value is CvContentType {
  return Object.values(CV_CONTENT_TYPES).includes(value as CvContentType)
}

export function extensionForContentType(contentType: CvContentType): 'pdf' | 'docx' {
  return contentType === CV_CONTENT_TYPES.pdf ? 'pdf' : 'docx'
}

export function toCvMetadata(version: CvVersion, currentVersionId: number | null): CvMetadata {
  return {
    id: version.id,
    originalFilename: version.originalFilename,
    contentType: version.contentType,
    sizeBytes: version.sizeBytes,
    sha256: version.sha256,
    createdAt: version.createdAt,
    current: version.id === currentVersionId,
  }
}

export async function getCvDocument(db: AppDatabase) {
  const [document] = await db
    .select()
    .from(cvDocuments)
    .where(eq(cvDocuments.id, CV_DOCUMENT_ID))
    .limit(1)
  return document
}

export async function findVersionByIdempotencyKey(
  db: AppDatabase,
  idempotencyKey: string,
) {
  const [version] = await db
    .select()
    .from(cvVersions)
    .where(eq(cvVersions.idempotencyKey, idempotencyKey))
    .limit(1)
  return version
}

export async function createCvVersion(
  db: AppDatabase,
  input: {
    objectKey: string
    originalFilename: string
    contentType: CvContentType
    sizeBytes: number
    sha256: string
    idempotencyKey: string
  },
): Promise<CvVersion> {
  const now = nowIso()
  await db
    .insert(cvDocuments)
    .values({ id: CV_DOCUMENT_ID, createdAt: now, updatedAt: now })
    .onConflictDoNothing()

  const [version] = await db
    .insert(cvVersions)
    .values({
      documentId: CV_DOCUMENT_ID,
      objectKey: input.objectKey,
      originalFilename: input.originalFilename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    })
    .returning()

  if (!version) {
    throw new Error('CV version insert returned no row')
  }

  await db
    .update(cvDocuments)
    .set({ currentVersionId: version.id, updatedAt: now })
    .where(eq(cvDocuments.id, CV_DOCUMENT_ID))

  return version
}

export async function listCvVersions(
  db: AppDatabase,
  limit: number,
  offset: number,
): Promise<{ versions: CvMetadata[]; total: number; currentVersionId: number | null }> {
  const document = await getCvDocument(db)
  const rows = await db
    .select()
    .from(cvVersions)
    .where(eq(cvVersions.documentId, CV_DOCUMENT_ID))
    .orderBy(desc(cvVersions.createdAt), desc(cvVersions.id))
    .limit(limit)
    .offset(offset)
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(cvVersions)
    .where(eq(cvVersions.documentId, CV_DOCUMENT_ID))

  return {
    versions: rows.map((version) => toCvMetadata(version, document?.currentVersionId ?? null)),
    total,
    currentVersionId: document?.currentVersionId ?? null,
  }
}

export async function getCvVersion(db: AppDatabase, id: number) {
  const document = await getCvDocument(db)
  const [version] = await db
    .select()
    .from(cvVersions)
    .where(and(eq(cvVersions.id, id), eq(cvVersions.documentId, CV_DOCUMENT_ID)))
    .limit(1)
  return version ? toCvMetadata(version, document?.currentVersionId ?? null) : undefined
}

export function createCvDb(binding: D1Database) {
  return createDb(binding)
}
