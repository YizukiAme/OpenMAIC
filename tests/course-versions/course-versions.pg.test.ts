import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureAgentSessionSchema } from '../../packages/@openmaic/storage/src/agent-session/pg';
import { ensureAssetSchema } from '../../packages/@openmaic/storage/src/asset/pg';
import {
  ensureDocumentSchema,
  type Queryable,
  type WithTransaction,
} from '../../packages/@openmaic/storage/src/document/pg';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  applyBranchRequests,
  readPendingBranchRequests,
  recordCourseVersions,
  type CourseVersionDeps,
} from '@/lib/server/course-versions/branching';
import {
  COURSE_VERSION_ROOT_KIND,
  checkoutCourseVersion,
  ensureCourseVersionSchema,
  snapshotCourse,
  type CourseVersionDatabase,
} from '@/lib/server/course-versions/store';
import { COURSE_VERSIONS_ENTRY, REPLY_VARIANT_ENTRY } from '@/lib/server/course-versions/tree';

import {
  MemoryDocuments,
  appendAssistant,
  appendUser,
  course,
  memorySession,
  titles,
} from './memory-tree';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = `openmaic_course_versions_${process.pid}`;
const OWNER = 'owner-1';
const STAGE = 'stage-photosynthesis';
const STAGE_B = 'stage-respiration';

function transactionFor(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client as Queryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

describe.skipIf(!contractUrl)('course versions (#1317 prototype)', () => {
  let admin: Pool;
  let pool: Pool;
  let db: CourseVersionDatabase;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const queryable = pool as unknown as Queryable;
    await ensureDocumentSchema(queryable);
    await ensureStageMetaSchema(queryable);
    await ensureAssetSchema(queryable);
    await ensureAgentSessionSchema(queryable);
    await ensureCourseVersionSchema(queryable);
    db = { queryable, withTransaction: transactionFor(pool) };
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE course_versions, course_version_pages, asset_root_refs, document_asset_refs,
                asset_entries, asset_blobs CASCADE`,
    );
  });

  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } finally {
      await Promise.all([pool?.end(), admin.end()]);
    }
  });

  describe('the store', () => {
    it('has nothing to record for a course that does not exist yet', async () => {
      const documents = new MemoryDocuments();
      expect(
        await snapshotCourse(db, { ownerId: OWNER, stageId: STAGE, origin: 'before_run', documents }),
      ).toBeNull();
    });

    it('reuses a version for equal content and stores each distinct page once', async () => {
      const documents = new MemoryDocuments();
      await documents.saveDocument(
        course(STAGE, [
          { id: 'p1', title: 'What it is' },
          { id: 'p2', title: 'Light reactions' },
          { id: 'p3', title: 'Calvin cycle' },
        ]),
      );
      const first = await snapshotCourse(db, {
        ownerId: OWNER,
        stageId: STAGE,
        origin: 'after_run',
        documents,
      });
      const again = await snapshotCourse(db, {
        ownerId: OWNER,
        stageId: STAGE,
        origin: 'before_run',
        documents,
      });
      expect(again?.id).toBe(first?.id);

      await documents.saveDocument(
        course(STAGE, [
          { id: 'p1', title: 'What it is' },
          { id: 'p2', title: 'Light reactions', extra: 'video' },
          { id: 'p3', title: 'Calvin cycle' },
        ]),
      );
      const second = await snapshotCourse(db, {
        ownerId: OWNER,
        stageId: STAGE,
        origin: 'after_run',
        documents,
      });
      expect(second?.id).not.toBe(first?.id);
      const pages = await pool.query('SELECT count(*)::int AS n FROM course_version_pages');
      // Three pages, then one changed page: four distinct rows, not six.
      expect(pages.rows[0].n).toBe(4);
    });

    it('writes a version back, and leaves an equal course alone', async () => {
      const documents = new MemoryDocuments();
      await documents.saveDocument(course(STAGE, [{ id: 'p1', title: 'Before' }]));
      const before = await snapshotCourse(db, {
        ownerId: OWNER,
        stageId: STAGE,
        origin: 'after_run',
        documents,
      });
      await documents.saveDocument(course(STAGE, [{ id: 'p1', title: 'After' }, { id: 'p2', title: 'New' }]));

      expect(
        await checkoutCourseVersion(db, { versionId: before!.id, stageId: STAGE, documents }),
      ).toBe('restored');
      expect(titles(await documents.loadDocument(STAGE))).toEqual(['Before']);
      const saves = documents.saves;
      expect(
        await checkoutCourseVersion(db, { versionId: before!.id, stageId: STAGE, documents }),
      ).toBe('unchanged');
      expect(documents.saves).toBe(saves);
      expect(
        await checkoutCourseVersion(db, { versionId: before!.id, stageId: 'other', documents }),
      ).toBe('missing');
    });

    it("roots the owner's assets the course names, and only those", async () => {
      const principal = assetPrincipalForOwner(OWNER).key;
      await pool.query(
        `INSERT INTO asset_blobs (content_hash, byte_size) VALUES ('h-video', 10), ('h-shared', 10)`,
      );
      await pool.query(
        `INSERT INTO asset_entries (id, principal, content_hash, mime, meta, created_at)
         VALUES ('asset-video', $1, 'h-video', 'video/mp4', '{}', 1),
                ('asset-shared', 'shared', 'h-shared', 'image/png', '{}', 1)`,
        [principal],
      );
      await pool.query(
        `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
         VALUES ($1, 'scene', 'p2', 'asset-video'), ($1, 'scene', 'p1', 'asset-shared')`,
        [STAGE],
      );
      const documents = new MemoryDocuments();
      await documents.saveDocument(course(STAGE, [{ id: 'p1', title: 'With media' }]));
      const version = await snapshotCourse(db, {
        ownerId: OWNER,
        stageId: STAGE,
        origin: 'after_run',
        documents,
      });
      const roots = await pool.query(
        'SELECT root_kind, root_id, asset_id FROM asset_root_refs ORDER BY asset_id',
      );
      expect(roots.rows).toEqual([
        { root_kind: COURSE_VERSION_ROOT_KIND, root_id: version!.id, asset_id: 'asset-video' },
      ]);
    });
  });

  describe('branches of a conversation', () => {
    function depsFor(documents: MemoryDocuments) {
      const { session, storage } = memorySession();
      const deps: CourseVersionDeps & { hasPendingMedia: () => boolean } = {
        sessionId: 'session-1',
        ownerId: OWNER,
        defaultStageId: STAGE,
        session,
        writeEntry: (write) => write(),
        documents,
        db,
        hasPendingMedia: () => false,
      };
      return { deps, session, storage };
    }

    const base = [
      { id: 'p1', title: 'What it is' },
      { id: 'p2', title: 'Light reactions' },
      { id: 'p3', title: 'Calvin cycle' },
    ];
    const withExtra = (pageId: string, extra: string) =>
      base.map((page) => (page.id === pageId ? { ...page, extra } : page));

    it('records a version only when a course changed', async () => {
      const documents = new MemoryDocuments();
      await documents.saveDocument(course(STAGE, base));
      const { deps, storage } = depsFor(documents);
      await recordCourseVersions(deps, { phase: 'after_run' });
      await recordCourseVersions(deps, { phase: 'before_run' });
      const marks = storage.entries.filter(
        (entry) => entry.type === 'custom' && (entry as { customType?: string }).customType === COURSE_VERSIONS_ENTRY,
      );
      expect(marks).toHaveLength(1);
    });

    it('regenerates, edits and switches with the course following the branch', async () => {
      const documents = new MemoryDocuments();
      await documents.saveDocument(course(STAGE, base));
      const { deps, session, storage } = depsFor(documents);

      // ① and its reply.
      await appendUser(session, 'make a photosynthesis lesson');
      await appendAssistant(session, 'outline and three pages');
      await recordCourseVersions(deps, { phase: 'after_run', status: 'succeeded' });

      // A hand edit between runs, then ③ (durable seq 7): the version taken
      // before the run keeps the hand edit.
      await documents.saveDocument(course(STAGE, withExtra('p1', 'hand-edited title')));
      await recordCourseVersions(deps, { phase: 'before_run' });
      await appendUser(session, 'add an experiment video to page 2', 7);
      await appendAssistant(session, 'added a video');
      await documents.saveDocument(
        course(STAGE, withExtra('p1', 'hand-edited title').map((page) =>
          page.id === 'p2' ? { ...page, extra: 'video' } : page,
        )),
      );
      await recordCourseVersions(deps, { phase: 'after_run', status: 'succeeded' });
      expect(titles(await documents.loadDocument(STAGE))).toEqual([
        'What it is+hand-edited title',
        'Light reactions+video',
        'Calvin cycle',
      ]);

      // Regenerate ③'s reply (request #20): the course goes back to just
      // before ③, hand edit included.
      const regenerated = await applyBranchRequests(deps, [
        { seq: 20, data: { op: 'regenerate', targetSeq: 7 } },
      ]);
      expect(regenerated.outcomes).toMatchObject([{ requestSeq: 20, status: 'applied' }]);
      expect(regenerated.regenerated).toBe(true);
      expect(titles(await documents.loadDocument(STAGE))).toEqual([
        'What it is+hand-edited title',
        'Light reactions',
        'Calvin cycle',
      ]);
      const leaf = await session.getLeafId();
      const marker = storage.entries.find((entry) => entry.id === leaf)!;
      expect(marker).toMatchObject({ type: 'custom', customType: REPLY_VARIANT_ENTRY, data: { requestSeq: 20 } });

      // The new reply builds an animation instead.
      await appendAssistant(session, 'added an animation');
      await documents.saveDocument(
        course(STAGE, withExtra('p1', 'hand-edited title').map((page) =>
          page.id === 'p2' ? { ...page, extra: 'animation' } : page,
        )),
      );
      await recordCourseVersions(deps, { phase: 'after_run', status: 'succeeded' });

      // Switch back to the original reply: the video is back.
      const backToOriginal = await applyBranchRequests(deps, [
        { seq: 25, data: { op: 'switch', targetSeq: 7, variant: 'orig' } },
      ]);
      expect(backToOriginal).toMatchObject({
        outcomes: [{ requestSeq: 25, op: 'switch', status: 'applied' }],
        regenerated: false,
      });
      expect(titles(await documents.loadDocument(STAGE))[1]).toBe('Light reactions+video');

      // A hand edit on this branch survives switching away and back.
      await documents.saveDocument(
        course(STAGE, withExtra('p1', 'hand-edited title').map((page) =>
          page.id === 'p2' ? { ...page, extra: 'video' } : page.id === 'p3' ? { ...page, extra: 'note' } : page,
        )),
      );
      await applyBranchRequests(deps, [{ seq: 26, data: { op: 'switch', targetSeq: 7, variant: 20 } }]);
      expect(titles(await documents.loadDocument(STAGE))).toEqual([
        'What it is+hand-edited title',
        'Light reactions+animation',
        'Calvin cycle',
      ]);
      await applyBranchRequests(deps, [{ seq: 27, data: { op: 'switch', targetSeq: 7, variant: 'orig' } }]);
      expect(titles(await documents.loadDocument(STAGE))).toEqual([
        'What it is+hand-edited title',
        'Light reactions+video',
        'Calvin cycle+note',
      ]);

      // Edit ③: the conversation goes to just before it, and so does the course.
      const edited = await applyBranchRequests(deps, [{ seq: 30, data: { op: 'edit', targetSeq: 7 } }]);
      expect(edited.outcomes).toMatchObject([{ requestSeq: 30, op: 'edit', status: 'applied' }]);
      expect(titles(await documents.loadDocument(STAGE))).toEqual([
        'What it is+hand-edited title',
        'Light reactions',
        'Calvin cycle',
      ]);
      const editLeaf = await session.getLeafId();
      const leafEntry = storage.entries.find((entry) => entry.id === editLeaf);
      expect(leafEntry).toMatchObject({ type: 'custom', customType: COURSE_VERSIONS_ENTRY });
    });

    it('changes nothing when a course cannot be restored', async () => {
      const documents = new MemoryDocuments();
      await documents.saveDocument(course(STAGE, base));
      await documents.saveDocument(course(STAGE_B, base));
      const { deps, session, storage } = depsFor(documents);
      await appendUser(session, 'make two lessons');
      await appendAssistant(session, 'two courses');
      await recordCourseVersions(deps, { phase: 'after_run', extraStageIds: [STAGE_B] });
      await appendUser(session, 'add a video to both', 7);
      await appendAssistant(session, 'added two videos');
      await documents.saveDocument(course(STAGE, withExtra('p2', 'video')));
      await documents.saveDocument(course(STAGE_B, withExtra('p2', 'video')));
      await recordCourseVersions(deps, { phase: 'after_run' });
      const leafBefore = await session.getLeafId();

      // The first course is written back, the second fails.
      documents.failSave(2);
      const failed = await applyBranchRequests(deps, [
        { seq: 20, data: { op: 'regenerate', targetSeq: 7 } },
      ]);
      expect(failed).toEqual({
        outcomes: [
          { requestSeq: 20, op: 'regenerate', status: 'rejected', reason: 'checkout_failed' },
        ],
        regenerated: false,
      });
      // Both courses are as the request found them, and so is the conversation:
      // its leaf is the request's before-switch entry on the same branch, and
      // no empty reply was left for a later switch to land on.
      expect(titles(await documents.loadDocument(STAGE))[1]).toBe('Light reactions+video');
      expect(titles(await documents.loadDocument(STAGE_B))[1]).toBe('Light reactions+video');
      const leafAfter = await session.getLeafId();
      expect(storage.entries.find((entry) => entry.id === leafAfter)).toMatchObject({
        parentId: leafBefore,
        customType: COURSE_VERSIONS_ENTRY,
        data: { phase: 'before_switch', requestSeq: 20 },
      });
      expect(
        storage.entries.some(
          (entry) => (entry as { customType?: string }).customType === REPLY_VARIANT_ENTRY,
        ),
      ).toBe(false);

      // Once saving works again, the same request lands.
      const retried = await applyBranchRequests(deps, [
        { seq: 21, data: { op: 'regenerate', targetSeq: 7 } },
      ]);
      expect(retried.outcomes).toMatchObject([{ requestSeq: 21, status: 'applied' }]);
      expect(titles(await documents.loadDocument(STAGE))[1]).toBe('Light reactions');
      expect(titles(await documents.loadDocument(STAGE_B))[1]).toBe('Light reactions');
    });

    it('applies a request again after a claim died part-way, without recording on the wrong branch', async () => {
      const documents = new MemoryDocuments();
      await documents.saveDocument(course(STAGE, base));
      const { deps, session } = depsFor(documents);
      await appendUser(session, 'make a photosynthesis lesson');
      await appendAssistant(session, 'three pages');
      await recordCourseVersions(deps, { phase: 'after_run', status: 'succeeded' });
      await appendUser(session, 'add a video to page 2', 7);
      await appendAssistant(session, 'added a video');
      await documents.saveDocument(course(STAGE, withExtra('p2', 'video')));
      const [video] = await recordCourseVersions(deps, { phase: 'after_run', status: 'succeeded' });
      await applyBranchRequests(deps, [{ seq: 20, data: { op: 'regenerate', targetSeq: 7 } }]);
      await appendAssistant(session, 'added an animation');
      await documents.saveDocument(course(STAGE, withExtra('p2', 'animation')));
      await recordCourseVersions(deps, { phase: 'after_run', status: 'succeeded' });

      // A claim got this far with switch #25 before it died: the before-switch
      // entry is written and the course is already the original reply's, but
      // the leaf is still on the regenerated reply.
      await recordCourseVersions(deps, { phase: 'before_switch', requestSeq: 25 });
      await checkoutCourseVersion(db, { versionId: video!.versionId, stageId: STAGE, documents });

      const again = await applyBranchRequests(deps, [
        { seq: 25, data: { op: 'switch', targetSeq: 7, variant: 'orig' } },
      ]);
      expect(again.outcomes).toMatchObject([{ requestSeq: 25, status: 'applied' }]);
      expect(titles(await documents.loadDocument(STAGE))[1]).toBe('Light reactions+video');

      // The half-switched course was not recorded onto the regenerated reply's
      // branch: it still has its own course.
      await applyBranchRequests(deps, [
        { seq: 26, data: { op: 'switch', targetSeq: 7, variant: 20 } },
      ]);
      expect(titles(await documents.loadDocument(STAGE))[1]).toBe('Light reactions+animation');
    });

    it('does not bring a deleted course back', async () => {
      const documents = new MemoryDocuments();
      await documents.saveDocument(course(STAGE, base));
      const { deps, session } = depsFor(documents);
      await appendUser(session, 'make a photosynthesis lesson');
      await appendAssistant(session, 'three pages');
      await recordCourseVersions(deps, { phase: 'after_run', status: 'succeeded' });
      await appendUser(session, 'add a video to page 2', 7);
      await appendAssistant(session, 'added a video');
      await documents.saveDocument(course(STAGE, withExtra('p2', 'video')));
      await recordCourseVersions(deps, { phase: 'after_run', status: 'succeeded' });

      documents.documents.delete(STAGE);
      const result = await applyBranchRequests(deps, [
        { seq: 20, data: { op: 'regenerate', targetSeq: 7 } },
      ]);
      expect(result.outcomes).toMatchObject([
        { requestSeq: 20, status: 'applied', checkedOut: [{ stageId: STAGE, outcome: 'missing' }] },
      ]);
      expect(await documents.loadDocument(STAGE)).toBeNull();
    });

    it('refuses to move while a media job could still patch the course', async () => {
      const documents = new MemoryDocuments();
      await documents.saveDocument(course(STAGE, base));
      const { deps, session } = depsFor(documents);
      await appendUser(session, 'first', 3);
      await appendAssistant(session, 'done');
      const result = await applyBranchRequests(
        { ...deps, hasPendingMedia: () => true },
        [{ seq: 9, data: { op: 'regenerate', targetSeq: 3 } }],
      );
      expect(result.outcomes).toEqual([
        { requestSeq: 9, op: 'regenerate', status: 'rejected', reason: 'media_pending' },
      ]);
    });
  });

  describe('pending requests', () => {
    it('are the requests no lifecycle frame has reported', async () => {
      await pool.query('TRUNCATE agent_session_events, agent_sessions CASCADE');
      await pool.query(
        `INSERT INTO agent_sessions (id, owner_id, prompt, stage_id, status, attempt, created_at, updated_at)
         VALUES ('s1', $1, 'p', $2, 'succeeded', 0, now(), now())`,
        [OWNER, STAGE],
      );
      const insert = (seq: number, type: string, data: unknown) =>
        pool.query(
          `INSERT INTO agent_session_events (session_id, seq, ts, attempt, type, data)
           VALUES ('s1', $1, $2, 0, $3, $4::jsonb)`,
          [seq, seq, type, JSON.stringify(data)],
        );
      await insert(1, 'session_start', { prompt: 'p' });
      await insert(2, 'branch_request', { op: 'regenerate', targetSeq: 0 });
      await insert(3, 'session_resumed', { reason: 'follow_up', branches: [{ requestSeq: 2 }] });
      await insert(4, 'branch_request', { op: 'switch', targetSeq: 0, variant: 'orig' });
      await insert(5, 'message_update', {});
      const pending = await readPendingBranchRequests(pool as unknown as Queryable, 's1');
      expect(pending).toEqual([{ seq: 4, data: { op: 'switch', targetSeq: 0, variant: 'orig' } }]);
    });
  });
});
