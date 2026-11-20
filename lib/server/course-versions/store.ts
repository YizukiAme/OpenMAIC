/** Immutable course versions on the agent session's message tree. Pages with
 * equal content share storage. The live document revision skips all page reads
 * on an unchanged turn, and the document store publishes the normal canvas
 * revisions on checkout. */
import { createHash, randomUUID } from 'node:crypto';

import { DSL_VERSION } from '@openmaic/dsl';
import type { MaicDocument } from '@openmaic/storage';
import { changeAssetRoots } from '@openmaic/storage/asset/pg';
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { assetReferencePrincipalsForOwner } from '@/lib/persistence/owner-assets';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';

/** The asset root kind a course version holds its assets under. */
export const COURSE_VERSION_ROOT_KIND = 'course_version';

/** Why a version was taken. Diagnostic only: nothing branches on it. */
type CourseVersionOrigin = 'before_run' | 'after_run' | 'before_switch';

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
  migrations: [
    { version: 1, name: 'baseline', up: COURSE_VERSION_SCHEMA, transaction: false },
    {
      version: 2,
      name: 'observed-document-revision',
      transaction: true,
      up: `ALTER TABLE course_versions ADD COLUMN observed_revision BIGINT;
           CREATE INDEX course_versions_stage_revision_idx
             ON course_versions (stage_id, observed_revision) WHERE observed_revision IS NOT NULL;`,
    },
  ],
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
export function ensureCourseVersionStore(
  pool: ConnectableQueryable | null | undefined,
): Promise<void> {
  if (!pool) return Promise.reject(new Error('course versions need a database pool'));
  const ensured = (ensuredState[ENSURED_KEY] ??= new WeakMap());
  const existing = ensured.get(pool);
  if (existing) return existing;
  const attempt = withSchemaBootstrapLock(pool, ensureCourseVersionSchema).catch((error) => {
    ensured.delete(pool);
    throw error;
  });
  ensured.set(pool, attempt);
  return attempt;
}

/** One page of a version: the scene id it is stored under and its content hash. */
interface CourseVersionPage {
  sceneId: string;
  hash: string;
}

export interface CourseVersionDatabase {
  queryable: Queryable;
  withTransaction: WithTransaction;
}

/**
 * JSON with object keys in code-unit order, so equal content hashes equally
 * whatever order a writer happened to build its objects in.
 */
function canonicalJson(value: unknown): string {
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

/** The content identity of one document: what equal versions share. */
function documentContentHash(document: MaicDocument): {
  contentHash: string;
  pages: CourseVersionPage[];
  pageData: Map<string, unknown>;
} {
  const pageData = new Map<string, unknown>();
  const pages = document.scenes.map((scene) => {
    const hash = sha256(canonicalJson(scene));
    pageData.set(hash, scene);
    return { sceneId: scene.id, hash };
  });
  // `updatedAt` records when the course last changed, not what it contains: a
  // checkout stamps it fresh, and two writes of the same content must still
  // hash equally.
  const { updatedAt: _updatedAt, ...stageContent } = document.stage;
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

/** Lock all courses and their assets in one order before a multi-course branch move. */
export async function lockCourseVersionStages(
  tx: Queryable,
  ownerId: string,
  stageIds: Iterable<string>,
  targetVersionIds: Iterable<string>,
): Promise<void> {
  const ids = [...stageIds];
  const stages = await tx.query<{ stage_id: string }>(
    `SELECT stage_id FROM stage_meta
      WHERE stage_id = ANY($1::text[]) AND owner_id = $2 AND deleted_at IS NULL
      ORDER BY stage_id FOR UPDATE`,
    [ids, ownerId],
  );
  // Both the document reference writer and the root writer lock asset entries.
  // Take their union first so two courses sharing media cannot invert that order.
  await tx.query(
    `SELECT id FROM asset_entries WHERE id IN (
       SELECT asset_id FROM document_asset_refs WHERE stage_id = ANY($1::text[])
       UNION ALL
       SELECT r.asset_id FROM asset_root_refs r JOIN course_versions v ON v.id = r.root_id
        WHERE r.root_kind = $2 AND v.stage_id = ANY($1::text[]) AND v.id = ANY($3::text[])
     ) ORDER BY id FOR NO KEY UPDATE`,
    [stages.rows.map((row) => row.stage_id), COURSE_VERSION_ROOT_KIND, [...targetVersionIds]],
  );
}

/** Ordinary reads are shared by link. A version may only belong to a live course of this owner. */
async function lockOwnedCourse(tx: Queryable, stageId: string, ownerId: string) {
  const result = await tx.query(
    `SELECT 1 FROM stage_meta WHERE stage_id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [stageId, ownerId],
  );
  return result.rows.length > 0;
}

function documentsIn(tx: Queryable, ownerId: string) {
  return createOwnerBoundDocumentStore({
    transaction: tx,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

const CURRENT_REVISION =
  'COALESCE((SELECT rev FROM document_stage_revision WHERE stage_id = $1), 0)';

/** Only the last observed database revision moves. The saved content stays immutable. */
async function markObserved(tx: Queryable, stageId: string, versionId: string) {
  await tx.query(
    `UPDATE course_versions SET observed_revision = ${CURRENT_REVISION} WHERE id = $2`,
    [stageId, versionId],
  );
}

async function pinVersionAssets(tx: Queryable, ownerId: string, stageId: string, id: string) {
  const principals = [...assetReferencePrincipalsForOwner(ownerId)];
  // A retained reference belongs to another server record, not to the saved course.
  // Legacy shared entries, like owned entries, refuse replacement while rooted.
  const assets = await tx.query<{ id: string }>(
    `SELECT id FROM asset_entries WHERE principal = ANY($2::text[]) AND id IN
       (SELECT asset_id FROM document_asset_refs WHERE stage_id = $1 AND scope <> 'retained')
       AND NOT EXISTS (SELECT 1 FROM asset_root_refs r
                       WHERE r.root_kind = $3 AND r.root_id = $4 AND r.asset_id = asset_entries.id)
     ORDER BY id`,
    [stageId, principals, COURSE_VERSION_ROOT_KIND, id],
  );
  if (!assets.rows.length) return;
  const assetIds = assets.rows.map((row) => row.id);
  await changeAssetRoots(tx, {
    add: [{ rootKind: COURSE_VERSION_ROOT_KIND, rootId: id, assetIds }],
    principals,
  });
}

export async function snapshotCourse(
  db: CourseVersionDatabase,
  input: {
    ownerId: string;
    stageId: string;
    sessionId?: string;
    origin: CourseVersionOrigin;
  },
): Promise<{ id: string } | null> {
  const { stageId } = input;
  return db.withTransaction(async (tx) => {
    const ownerId = await forwardOwnerWrite(tx, input.ownerId);
    if (!(await lockOwnedCourse(tx, stageId, ownerId))) return null;

    // This statement starts after the lock wait, so it sees the last writer's commit.
    const seen = await tx.query<{ id: string }>(
      `SELECT id FROM course_versions WHERE stage_id = $1 AND observed_revision = ${CURRENT_REVISION}
       ORDER BY created_at, id LIMIT 1`,
      [stageId],
    );
    if (seen.rows[0]) return seen.rows[0];
    const document = await documentsIn(tx, ownerId).loadDocument(stageId);
    if (!document) return null;

    const { contentHash, pages, pageData } = documentContentHash(document);
    const existing = await tx.query<{ id: string }>(
      // v1 hashes used null for an absent outline. The row retains which it was.
      `SELECT id FROM course_versions WHERE stage_id = $1 AND content_hash = $2
        AND (outline IS NULL) = $3 ORDER BY created_at, id LIMIT 1`,
      [stageId, contentHash, document.outline === undefined],
    );
    if (existing.rows[0]) {
      const { id } = existing.rows[0];
      // A later save may have resolved an asset the identical draft once lacked.
      await pinVersionAssets(tx, ownerId, stageId, id);
      await markObserved(tx, stageId, id);
      return { id };
    }

    const id = `cv_${randomUUID()}`;
    const createdAt = Date.now();
    await tx.query(
      `INSERT INTO course_version_pages (content_hash, data, created_at)
       SELECT key, value, $2 FROM jsonb_each($1::jsonb) ORDER BY key
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(Object.fromEntries(pageData)), createdAt],
    );
    await tx.query(
      `INSERT INTO course_versions
         (stage_id, id, owner_id, content_hash, stage, outline, dsl_version, pages,
          session_id, origin, created_at, observed_revision)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, ${CURRENT_REVISION})`,
      [
        stageId,
        id,
        ownerId,
        contentHash,
        JSON.stringify(document.stage),
        JSON.stringify(document.outline),
        document.dslVersion ?? null,
        JSON.stringify(pages),
        input.sessionId ?? null,
        input.origin,
        createdAt,
      ],
    );
    await pinVersionAssets(tx, ownerId, stageId, id);
    return { id };
  });
}

export type CheckoutOutcome = 'unchanged' | 'restored' | 'missing';

export async function checkoutCourseVersion(
  db: CourseVersionDatabase,
  input: { versionId: string; stageId: string; ownerId: string },
): Promise<CheckoutOutcome> {
  const { stageId, versionId } = input;
  return db.withTransaction(async (tx) => {
    const ownerId = await forwardOwnerWrite(tx, input.ownerId);
    if (!(await lockOwnedCourse(tx, stageId, ownerId))) return 'missing';

    const result = await tx.query<{
      stage: MaicDocument['stage'];
      outline: unknown;
      has_outline: boolean;
      dsl_version: string | null;
      matches_revision: boolean | null;
      current_dsl: boolean | null;
      stage_changed: boolean;
      outline_changed: boolean;
    }>(
      `SELECT v.stage, v.outline, v.outline IS NOT NULL AS has_outline, v.dsl_version,
              v.observed_revision = ${CURRENT_REVISION} AS matches_revision,
              (s.data->>'dslVersion' = $3 AND v.dsl_version = $3) AS current_dsl,
              (s.data - 'dslVersion' - 'updatedAt') IS DISTINCT FROM (v.stage - 'updatedAt') AS stage_changed,
              o.data IS DISTINCT FROM v.outline AS outline_changed
         FROM course_versions v JOIN document_stages s ON s.id = v.stage_id
         LEFT JOIN document_outlines o ON o.stage_id = s.id
        WHERE v.stage_id = $1 AND v.id = $2`,
      [stageId, versionId, DSL_VERSION],
    );
    const version = result.rows[0];
    if (!version || version.stage.id !== stageId)
      throw new Error(`Missing version ${versionId} of course ${stageId}`);
    if (version.matches_revision) return 'unchanged';

    // For a current document, let jsonb compare each live row with its saved page.
    // Only changed rows cross the connection or bump the canvas's scene revision.
    const pages = await tx.query<{
      id: string;
      in_version: boolean;
      data: MaicDocument['scenes'][number] | null;
    }>(
      `WITH target AS (
         SELECT page->>'sceneId' AS id, saved.data
           FROM jsonb_array_elements((SELECT pages FROM course_versions WHERE id = $2)) page
           LEFT JOIN course_version_pages saved ON saved.content_hash = page->>'hash'
       ), live AS (SELECT id, data FROM document_scenes WHERE stage_id = $1)
       SELECT COALESCE(target.id, live.id) AS id, target.id IS NOT NULL AS in_version, target.data
         FROM target FULL JOIN live USING (id)
        WHERE NOT $3::boolean OR target.data IS NULL OR target.data IS DISTINCT FROM live.data
        ORDER BY id`,
      [stageId, versionId, version.current_dsl === true],
    );
    const changed = [];
    const removed = [];
    for (const page of pages.rows) {
      if (!page.in_version) removed.push(page.id);
      else if (page.data) changed.push(page.data);
      else throw new Error(`Missing page ${page.id} of course version ${versionId}`);
    }
    const changedDocument =
      !version.current_dsl ||
      pages.rows.length > 0 ||
      version.stage_changed ||
      version.outline_changed;
    if (changedDocument) {
      await documentsIn(tx, ownerId).restoreDocument(
        {
          stage: { ...version.stage, updatedAt: Date.now() },
          scenes: changed.sort((a, b) => a.order - b.order),
          ...(version.has_outline ? { outline: version.outline } : {}),
          ...(version.dsl_version ? { dslVersion: version.dsl_version } : {}),
        },
        version.current_dsl
          ? { removedSceneIds: removed, outlineChanged: version.outline_changed }
          : undefined,
      );
    }
    await pinVersionAssets(tx, ownerId, stageId, versionId);
    await markObserved(tx, stageId, versionId);
    return changedDocument ? 'restored' : 'unchanged';
  });
}

/** Read one immutable course, preferring the open tab when the branch has several. */
export async function readCourseVersion(
  db: Queryable,
  ownerId: string,
  versions: string[],
  preferredCourse: string | null,
) {
  const result = await db.query<{ stage: MaicDocument['stage']; scenes: MaicDocument['scenes'] }>(
    `SELECT v.stage, ARRAY(SELECT p.data FROM jsonb_array_elements(v.pages) WITH ORDINALITY page(ref, pos)
          JOIN course_version_pages p ON p.content_hash = page.ref->>'hash' ORDER BY page.pos) AS scenes
       FROM course_versions v JOIN stage_meta m ON m.stage_id = v.stage_id
      WHERE v.id = ANY($1) AND m.owner_id = $2 AND m.deleted_at IS NULL
      ORDER BY (v.stage_id = $3) DESC, v.stage_id LIMIT 1`,
    [versions, ownerId, preferredCourse],
  );
  return result.rows[0] ?? null;
}
