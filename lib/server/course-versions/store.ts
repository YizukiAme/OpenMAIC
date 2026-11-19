/**
 * Course versions for edit-and-resend in Pro conversations (#1317, prototype).
 *
 * A course version is an immutable copy of one course document at one moment:
 * its stage row, outline and DSL version, plus the ordered list of its pages.
 * Pages are stored once per distinct content (content-addressed), so a version
 * that changes one page of a forty-page course adds one page row, and a version
 * whose content equals an earlier one of the same course reuses that version.
 *
 * The agent runner takes a version before and after every run, and a branch of
 * the conversation names the version it is on with a non-context entry in the
 * session's entry tree (`./tree.ts`). Switching branches writes the named
 * version back over the live document (`checkoutCourseVersion`), through the
 * same owner-bound document store every agent tool writes through.
 *
 * Assets a version names are held alive by an asset reference root
 * (`asset_root_refs`, kind {@link COURSE_VERSION_ROOT_KIND}), so the collector
 * never reclaims the video an older branch still shows.
 *
 * Deliberately app-side for the prototype: the tables live in their own
 * migration store (`course-versions`) instead of `@openmaic/storage`, so the
 * published package and its document migrations stay untouched. The production
 * home is the storage package's document store.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { MaicDocument } from '@openmaic/storage';
import { changeAssetRoots } from '@openmaic/storage/asset/pg';
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';

/** The asset root kind a course version holds its assets under. */
export const COURSE_VERSION_ROOT_KIND = 'course_version';

/** Why a version was taken. Diagnostic only: nothing branches on it. */
export type CourseVersionOrigin = 'before_run' | 'after_run' | 'before_switch';

const COURSE_VERSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS course_version_pages (
  content_hash TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS course_versions (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  stage JSONB NOT NULL,
  outline JSONB,
  dsl_version TEXT,
  pages JSONB NOT NULL,
  session_id TEXT,
  origin TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS course_versions_stage_content_idx
  ON course_versions (stage_id, content_hash);
CREATE INDEX IF NOT EXISTS course_versions_session_idx
  ON course_versions (session_id)
`;

export const COURSE_VERSION_MIGRATIONS: SchemaMigrationSet = {
  store: 'course-versions',
  migrations: [{ version: 1, name: 'baseline', up: COURSE_VERSION_SCHEMA, transaction: false }],
};

export async function ensureCourseVersionSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, COURSE_VERSION_MIGRATIONS);
}

const ENSURED_KEY = Symbol.for('openmaic.course-versions.ensured');
const ensuredState = globalThis as typeof globalThis & {
  [ENSURED_KEY]?: WeakMap<object, Promise<void>>;
};

/**
 * Provision the course-version tables once per pool, under the application's
 * schema bootstrap lock like every other lazily provisioned store. A failed
 * attempt is forgotten, so the next run retries it.
 */
export function ensureCourseVersionStore(pool: object | null | undefined): Promise<void> {
  if (typeof pool !== 'object' || pool === null) {
    return Promise.reject(new Error('course versions need a database pool'));
  }
  const ensured = (ensuredState[ENSURED_KEY] ??= new WeakMap());
  const existing = ensured.get(pool);
  if (existing) return existing;
  const attempt = withSchemaBootstrapLock(
    pool as unknown as ConnectableQueryable,
    ensureCourseVersionSchema,
  ).catch((error) => {
    ensured.delete(pool);
    throw error;
  });
  ensured.set(pool, attempt);
  return attempt;
}

/** One page of a version: the scene id it is stored under and its content hash. */
export interface CourseVersionPage {
  sceneId: string;
  hash: string;
}

/** A version as stored, without its page contents. */
export interface CourseVersionRecord {
  id: string;
  stageId: string;
  contentHash: string;
  pages: CourseVersionPage[];
  createdAt: number;
}

/** The document reads a snapshot or a checkout needs. */
export interface CourseDocumentReader {
  loadDocument(stageId: string): Promise<MaicDocument<never, never> | MaicDocument | null>;
}

/** The document writes a checkout needs: the owner-bound store's full save. */
export interface CourseDocumentWriter extends CourseDocumentReader {
  saveDocument(document: MaicDocument): Promise<void>;
}

export interface CourseVersionDatabase {
  queryable: Queryable;
  withTransaction: WithTransaction;
}

/**
 * JSON with object keys in code-unit order, so equal content hashes equally
 * whatever order a writer happened to build its objects in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface SceneLikeRecord {
  id: string;
}

/** The content identity of one document: what equal versions share. */
export function documentContentHash(document: MaicDocument): {
  contentHash: string;
  pages: CourseVersionPage[];
  pageData: Map<string, unknown>;
} {
  const pageData = new Map<string, unknown>();
  const pages = (document.scenes as SceneLikeRecord[]).map((scene) => {
    const hash = sha256(canonicalJson(scene));
    pageData.set(hash, scene);
    return { sceneId: scene.id, hash };
  });
  // `updatedAt` records when the course last changed, not what it contains: a
  // checkout stamps it fresh, and two writes of the same content must still
  // hash equally.
  const { updatedAt: _updatedAt, ...stageContent } = document.stage as unknown as Record<
    string,
    unknown
  >;
  const contentHash = sha256(
    canonicalJson({
      stage: stageContent,
      outline: document.outline ?? null,
      dslVersion: document.dslVersion ?? null,
      pages,
    }),
  );
  return { contentHash, pages, pageData };
}

/**
 * Record the course as it is now and return the version that names it.
 *
 * Returns `null` when the course does not exist (a run that has not created it
 * yet). A course whose content equals an existing version of the same course
 * returns that version rather than writing a new one, so taking a version
 * before every run costs one read and one hash when nothing changed.
 */
export async function snapshotCourse(
  db: CourseVersionDatabase,
  input: {
    ownerId: string;
    stageId: string;
    sessionId?: string;
    origin: CourseVersionOrigin;
    documents: CourseDocumentReader;
    now?: () => number;
  },
): Promise<CourseVersionRecord | null> {
  const document = (await input.documents.loadDocument(input.stageId)) as MaicDocument | null;
  if (!document) return null;
  const { contentHash, pages, pageData } = documentContentHash(document);
  const now = input.now ?? Date.now;

  const existing = await db.queryable.query<{ id: string; pages: unknown; created_at: number }>(
    `SELECT id, pages, created_at FROM course_versions
      WHERE stage_id = $1 AND content_hash = $2
      ORDER BY created_at ASC LIMIT 1`,
    [input.stageId, contentHash],
  );
  if (existing.rows[0]) {
    return {
      id: existing.rows[0].id,
      stageId: input.stageId,
      contentHash,
      pages: existing.rows[0].pages as CourseVersionPage[],
      createdAt: Number(existing.rows[0].created_at),
    };
  }

  const id = `cv_${randomUUID()}`;
  const createdAt = now();
  await db.withTransaction(async (tx) => {
    // The owner the version is for after any claim moved the course: the
    // background fence follows the claim forward, as the run's own store does.
    const ownerId = await forwardOwnerWrite(tx, input.ownerId);
    for (const [hash, data] of pageData) {
      await tx.query(
        `INSERT INTO course_version_pages (content_hash, data, created_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (content_hash) DO NOTHING`,
        [hash, JSON.stringify(data), createdAt],
      );
    }
    await tx.query(
      `INSERT INTO course_versions
         (id, stage_id, owner_id, content_hash, stage, outline, dsl_version, pages,
          session_id, origin, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11)`,
      [
        id,
        input.stageId,
        ownerId,
        contentHash,
        JSON.stringify(document.stage),
        document.outline === undefined ? null : JSON.stringify(document.outline),
        document.dslVersion ?? null,
        JSON.stringify(pages),
        input.sessionId ?? null,
        input.origin,
        createdAt,
      ],
    );
    await pinVersionAssets(tx, { versionId: id, stageId: input.stageId, ownerId });
  });
  return { id, stageId: input.stageId, contentHash, pages, createdAt };
}

/**
 * Hold every asset the course names right now under the version's root.
 *
 * The live document is the version's content at this moment, and the document
 * store keeps `document_asset_refs` in step with it, so its rows are exactly
 * the entries the version names -- by the store's own reference rules, with no
 * second heuristic. Only entries in the owner's own partition can be rooted
 * (the asset layer refuses anything else); entries in the legacy shared
 * partition are left to the document references that already hold them.
 */
async function pinVersionAssets(
  tx: Queryable,
  input: { versionId: string; stageId: string; ownerId: string },
): Promise<void> {
  const principal = assetPrincipalForOwner(input.ownerId).key;
  const owned = await tx.query<{ id: string }>(
    `SELECT e.id
       FROM asset_entries e
      WHERE e.principal = $2
        AND e.id IN (SELECT DISTINCT asset_id FROM document_asset_refs WHERE stage_id = $1)
      ORDER BY e.id`,
    [input.stageId, principal],
  );
  const assetIds = owned.rows.map((row) => row.id);
  if (assetIds.length === 0) return;
  await changeAssetRoots(tx, {
    add: [{ rootKind: COURSE_VERSION_ROOT_KIND, rootId: input.versionId, assetIds }],
    principals: [principal],
  });
}

/** A stored version with its page contents, ready to be written back. */
export async function loadCourseVersion(
  queryable: Queryable,
  versionId: string,
): Promise<{ record: CourseVersionRecord; document: MaicDocument } | null> {
  const result = await queryable.query<{
    id: string;
    stage_id: string;
    content_hash: string;
    stage: unknown;
    outline: unknown;
    dsl_version: string | null;
    pages: unknown;
    created_at: number;
  }>(
    `SELECT id, stage_id, content_hash, stage, outline, dsl_version, pages, created_at
       FROM course_versions WHERE id = $1`,
    [versionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const pages = row.pages as CourseVersionPage[];
  const hashes = [...new Set(pages.map((page) => page.hash))];
  const stored = await queryable.query<{ content_hash: string; data: unknown }>(
    `SELECT content_hash, data FROM course_version_pages WHERE content_hash = ANY($1::text[])`,
    [hashes],
  );
  const byHash = new Map(stored.rows.map((page) => [page.content_hash, page.data]));
  const scenes = pages.map((page) => {
    const data = byHash.get(page.hash);
    if (data === undefined) {
      throw new Error(`course version ${versionId} is missing page ${page.hash}`);
    }
    return data;
  });
  const document: MaicDocument = {
    stage: row.stage as MaicDocument['stage'],
    scenes: scenes as MaicDocument['scenes'],
    ...(row.outline === null || row.outline === undefined ? {} : { outline: row.outline }),
    ...(row.dsl_version ? { dslVersion: row.dsl_version } : {}),
  };
  return {
    record: {
      id: row.id,
      stageId: row.stage_id,
      contentHash: row.content_hash,
      pages,
      createdAt: Number(row.created_at),
    },
    document,
  };
}

/**
 * `missing`: nothing was written, because the version is gone or the course
 * was deleted since. A branch switch never brings a deleted course back.
 */
export type CheckoutOutcome = 'unchanged' | 'restored' | 'missing';

/**
 * Write a version back over the live course.
 *
 * Goes through the caller's owner-bound document store, so the write is the
 * same owner-checked, reference-tracked, revision-bumping save an agent tool
 * makes, and the canvas refreshes through its ordinary freshness sync. A live
 * course whose content already equals the version is left alone, and so is a
 * course that no longer exists.
 */
export async function checkoutCourseVersion(
  db: CourseVersionDatabase,
  input: { versionId: string; stageId: string; documents: CourseDocumentWriter },
): Promise<CheckoutOutcome> {
  const loaded = await loadCourseVersion(db.queryable, input.versionId);
  if (!loaded || loaded.record.stageId !== input.stageId) return 'missing';
  const live = (await input.documents.loadDocument(input.stageId)) as MaicDocument | null;
  if (!live) return 'missing';
  if (documentContentHash(live).contentHash === loaded.record.contentHash) return 'unchanged';
  // Restoring is a change to the course: it is stamped as one, so course lists
  // order it by now rather than by when the version was first taken.
  await input.documents.saveDocument({
    ...loaded.document,
    stage: { ...loaded.document.stage, updatedAt: Date.now() },
  });
  return 'restored';
}

/** Whether the live course still has the content of a version. */
export async function liveMatchesVersion(
  db: CourseVersionDatabase,
  input: { versionId: string; stageId: string; documents: CourseDocumentReader },
): Promise<boolean> {
  const live = (await input.documents.loadDocument(input.stageId)) as MaicDocument | null;
  if (!live) return false;
  const result = await db.queryable.query<{ content_hash: string }>(
    'SELECT content_hash FROM course_versions WHERE id = $1 AND stage_id = $2',
    [input.versionId, input.stageId],
  );
  const row = result.rows[0];
  return row !== undefined && row.content_hash === documentContentHash(live).contentHash;
}
