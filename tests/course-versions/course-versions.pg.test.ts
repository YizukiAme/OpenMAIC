import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Session } from '@earendil-works/pi-agent-core';

import { PgAgentSessionStore, ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { AssetCollector } from '@openmaic/storage/asset/collector';
import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import {
  ensureDocumentSchema,
  readStageFreshnessManifest,
  type Queryable,
} from '@openmaic/storage/document/pg';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { diffStageManifest } from '@/lib/workbench/stage-freshness';
import {
  assetPrincipalForOwner,
  assetReferencePrincipalsForOwner,
} from '@/lib/persistence/owner-assets';
import { STAGE_META_OWNERSHIP } from '@/lib/persistence/stage-meta-ownership';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { AgentSessionEntryStorage } from '@/lib/server/agent-runtime/entry-tree-storage';
import {
  applyBranchRequests,
  recordCourseVersions,
  type CourseVersionDeps,
} from '@/lib/server/course-versions/branching';
import {
  COURSE_VERSION_ROOT_KIND,
  checkoutCourseVersion,
  ensureCourseVersionSchema,
  snapshotCourse,
  readCourseVersion,
  type CourseVersionDatabase,
} from '@/lib/server/course-versions/store';
import { agentSessionStoreIn, nodePostgresTransaction } from '@/lib/server/agent-runtime/store';
import { readAgentMessageLog } from '@/lib/server/agent-runtime/user-messages';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import { COURSE_VERSIONS_ENTRY, type BranchRequestData } from '@/lib/server/course-versions/tree';

import { appendAssistant, appendUser, course, titles } from './memory-tree';

const contractUrl = process.env.PG_CONTRACT_URL;
if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl)
  throw new Error('Course versions require PG_CONTRACT_URL for the PostgreSQL contract tests');
const TEST_SCHEMA = `openmaic_course_versions_${process.pid}`;
const OWNER = 'owner-1';
const base = [
  { id: 'p1', title: 'What it is' },
  { id: 'p2', title: 'Light reactions' },
  { id: 'p3', title: 'Calvin cycle' },
];
const withExtra = (pageId: string, extra: string) =>
  base.map((page) => (page.id === pageId ? { ...page, extra } : page));
const STAGE = 'stage-photosynthesis';
const STAGE_B = 'stage-respiration';

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
    db = { queryable, withTransaction: nodePostgresTransaction(pool) };
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE course_versions, course_version_pages, asset_root_refs, document_asset_refs,
                asset_entries, asset_blobs, agent_sessions, document_stages, document_stage_revision, document_scene_revision CASCADE`,
    );
  });

  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } finally {
      await Promise.all([pool?.end(), admin.end()]);
    }
  });

  function documents(ownerId = OWNER) {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  }

  const snapshot = (stageId = STAGE) =>
    snapshotCourse(db, { ownerId: OWNER, stageId, origin: 'after_run' });
  const checkout = (versionId: string, stageId = STAGE) =>
    checkoutCourseVersion(db, { ownerId: OWNER, stageId, versionId });
  const manifest = (stageId = STAGE) => readStageFreshnessManifest(stageId, db.queryable);

  describe('the store', () => {
    it('only snapshots live courses owned by the runner, including when it has a shared link', async () => {
      expect(await snapshot()).toBeNull();
      await documents('a-different-owner').saveDocument(course(STAGE, base));
      expect(await documents().loadDocument(STAGE)).not.toBeNull();
      expect(await snapshot()).toBeNull();
      expect((await pool.query('SELECT id FROM course_versions')).rows).toEqual([]);
    });

    it('lets only the owner read saved pages in order without rewinding the live course', async () => {
      const store = documents();
      await store.saveDocument(course(STAGE, base));
      const original = (await snapshot())!.id;
      await store.saveDocument(course(STAGE, [base[2]!]));
      const before = await manifest();
      const preview = await readCourseVersion(db.queryable, OWNER, original);
      expect(preview?.scenes.map((s) => s.id)).toEqual(base.map((s) => s.id));
      expect(await manifest()).toEqual(before);
      expect(await readCourseVersion(db.queryable, 'other-owner', original)).toBeNull();
    });

    it('reuses one version across concurrent snapshots, same-content saves and checkouts', async () => {
      const store = documents();
      await store.saveDocument(course(STAGE, base));
      const versions = await Promise.all(Array.from({ length: 4 }, () => snapshot()));
      const original = versions[0]!.id;
      expect(new Set(versions.map((version) => version!.id)).size).toBe(1);
      await store.saveDocument(course(STAGE, withExtra('p2', 'video')));
      expect((await snapshot())!.id).not.toBe(original);
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM course_version_pages')).rows[0].count,
      ).toBe(4);
      await store.saveDocument(course(STAGE, base));
      expect((await snapshot())!.id).toBe(original);
      const before = await manifest();
      expect(await checkout(original)).toBe('unchanged');
      expect(await manifest()).toEqual(before);
    });

    it('restores only changed, added or removed pages, including outline and stage-only changes', async () => {
      const store = documents();
      const saved = course(STAGE, base);
      saved.outline = { requirements: ['practice'] };
      await store.saveDocument(saved);
      const original = (await snapshot())!.id;
      await store.saveDocument(
        course(STAGE, [base[0]!, { ...base[1]!, extra: 'video' }, { id: 'p4', title: 'New' }]),
      );
      const previous = await manifest();
      expect(await checkout(original)).toBe('restored');
      expect(diffStageManifest(previous, await manifest())).toEqual({
        changed: ['p2'],
        added: ['p3'],
        removed: ['p4'],
      });
      expect(await store.loadDocument(STAGE)).toMatchObject({
        outline: { requirements: ['practice'] },
      });
      const restored = (await store.loadDocument(STAGE))!;
      await store.saveDocument({
        ...restored,
        stage: { ...restored.stage, name: 'Renamed' },
        outline: null,
      });
      const oldManifest = await manifest();
      expect(await checkout(original)).toBe('restored');
      expect((await store.loadDocument(STAGE))!.stage.name).toBe('Photosynthesis');
      expect((await manifest()).scenes).toEqual(oldManifest.scenes);
      await store.saveDocument(course(STAGE, [base[1]!, base[0]!, base[2]!]));
      const reordered = await manifest();
      await checkout(original);
      expect(diffStageManifest(reordered, await manifest()).changed).toEqual(['p1', 'p2']);
      expect(titles(await store.loadDocument(STAGE))).toEqual([
        'What it is',
        'Light reactions',
        'Calvin cycle',
      ]);
    });

    it('retains owned and legacy shared media after leaving their branch', async () => {
      const store = documents();
      await store.saveDocument(course(STAGE, base));
      const empty = (await snapshot())!.id;
      await pool.query("INSERT INTO asset_blobs (content_hash, byte_size) VALUES ('media', 10)");
      await pool.query(
        `INSERT INTO asset_entries(id,principal,content_hash,mime,meta,created_at)
          VALUES ('own', $1, 'media','video/mp4','{}',1), ('legacy','shared','media','video/mp4','{}',1),
                 ('foreign','owner:other','media','video/mp4','{}',1), ('retained',$1,'media','video/mp4','{}',1)`,
        [assetPrincipalForOwner(OWNER).key],
      );
      const withMedia = course(STAGE, base);
      withMedia.stage.videoManifest = Object.fromEntries(
        ['own', 'legacy', 'foreign'].map((id) => [id, { type: 'video', prompt: 'An experiment' }]),
      );
      await store.saveDocument(withMedia);
      await pool.query(
        "INSERT INTO document_asset_refs (stage_id,scope,scene_id,asset_id) VALUES ($1,'retained','server','retained')",
        [STAGE],
      );
      const media = (await snapshot())!.id;
      expect(await checkout(empty)).toBe('restored');
      expect(
        (await pool.query("SELECT asset_id FROM document_asset_refs WHERE scope <> 'retained'"))
          .rows,
      ).toEqual([]);
      expect(
        (
          await pool.query(
            'SELECT asset_id FROM asset_root_refs WHERE root_kind=$1 AND root_id=$2 ORDER BY asset_id',
            [COURSE_VERSION_ROOT_KIND, media],
          )
        ).rows,
      ).toEqual([{ asset_id: 'legacy' }, { asset_id: 'own' }]);
      await pool.query(`UPDATE asset_entries SET committed_at='2000-01-01', unreferenced_at='2000-01-01'
        WHERE id='foreign'`);
      const collector = new AssetCollector(db.queryable, new PgAssetByteStore(db.queryable), {
        withTransaction: db.withTransaction,
        documentReferences: true,
        documentOwnership: STAGE_META_OWNERSHIP,
        assetReferencePrincipals: assetReferencePrincipalsForOwner,
      });
      expect((await collector.collectPass()).entriesCollected).toBe(1);
      expect(await checkout(media)).toBe('restored');
      expect(
        (
          await pool.query(
            "SELECT asset_id FROM document_asset_refs WHERE scope <> 'retained' ORDER BY asset_id",
          )
        ).rows,
      ).toEqual([{ asset_id: 'legacy' }, { asset_id: 'own' }]);
    });

    it('gives a pre-upgrade version its shared media root when it is used again', async () => {
      const store = documents();
      await pool.query("INSERT INTO asset_blobs (content_hash, byte_size) VALUES ('old-media', 1)");
      await pool.query(`INSERT INTO asset_entries(id,principal,content_hash,mime,meta,created_at)
        VALUES ('legacy','shared','old-media','video/mp4','{}',1)`);
      const withMedia = course(STAGE, base);
      withMedia.stage.videoManifest = { legacy: { type: 'video', prompt: 'An experiment' } };
      await store.saveDocument(withMedia);
      const original = (await snapshot())!.id;
      // v1 versions have no observed revision or shared-asset roots.
      await pool.query('UPDATE course_versions SET observed_revision=NULL WHERE id=$1', [original]);
      await pool.query('DELETE FROM asset_root_refs WHERE root_id=$1', [original]);
      expect((await snapshot())?.id).toBe(original);
      await store.saveDocument(course(STAGE, base));
      expect(
        (await pool.query('SELECT asset_id FROM asset_root_refs WHERE root_id=$1', [original]))
          .rows,
      ).toEqual([{ asset_id: 'legacy' }]);
    });

    it('pins a newly available asset when a save reuses an earlier version', async () => {
      const store = documents();
      const withMedia = course(STAGE, base);
      withMedia.stage.videoManifest = { late: { type: 'video', prompt: 'An experiment' } };
      await store.saveDocument(withMedia);
      const original = (await snapshot())!.id;
      await pool.query("INSERT INTO asset_blobs (content_hash, byte_size) VALUES ('media', 1)");
      await pool.query(`INSERT INTO asset_entries(id,principal,content_hash,mime,meta,created_at)
        VALUES ('late','shared','media','video/mp4','{}',1)`);
      await store.saveDocument(withMedia);
      expect((await snapshot())?.id).toBe(original);
      await store.saveDocument(course(STAGE, base));
      expect(
        (await pool.query('SELECT asset_id FROM asset_root_refs WHERE root_id=$1', [original]))
          .rows,
      ).toEqual([{ asset_id: 'late' }]);
    });

    it('reuses v1 hashes while distinguishing a missing outline from an explicit null', async () => {
      const doc = course(STAGE, base);
      const store = documents();
      await store.saveDocument(doc);
      const v1 = (await snapshot())!.id;
      // The v1 content hash included "outline: null" for either representation.
      await pool.query(
        "UPDATE course_versions SET outline='null'::jsonb, observed_revision=NULL WHERE id=$1",
        [v1],
      );
      await store.saveDocument({ ...doc, outline: null });
      expect((await snapshot())!.id).toBe(v1);
      await store.saveDocument(doc);
      expect((await snapshot())!.id).not.toBe(v1);
      expect(await checkout(v1)).toBe('restored');
      expect(await store.loadDocument(STAGE)).toHaveProperty('outline', null);
    });

    it('restores a legacy DSL document and refuses to replace a newer DSL or another course', async () => {
      const store = documents();
      await store.saveDocument(course(STAGE, base));
      const original = (await snapshot())!.id;
      await store.saveDocument(course(STAGE, withExtra('p2', 'video')));
      await pool.query("UPDATE document_stages SET data=data-'dslVersion' WHERE id=$1", [STAGE]);
      expect(await checkout(original)).toBe('restored');
      expect(titles(await store.loadDocument(STAGE))[1]).toBe('Light reactions');
      await pool.query(
        `UPDATE document_stages SET data=data || '{"dslVersion":"99.0.0"}'::jsonb WHERE id=$1`,
        [STAGE],
      );
      await expect(checkout(original)).rejects.toMatchObject({ kind: 'future' });
      await store.saveDocument(course(STAGE_B, withExtra('p2', 'other')));
      await expect(checkout(original, STAGE_B)).rejects.toThrow();
      expect(titles(await store.loadDocument(STAGE_B))[1]).toBe('Light reactions+other');
    });

    it('preserves an editor save concurrent with checkout', async () => {
      const store = documents();
      await store.saveDocument(course(STAGE, base));
      const original = (await snapshot())!.id;
      await store.saveDocument(course(STAGE, withExtra('p2', 'video')));
      const switched = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<void>();
      const checkingOut = db.withTransaction(async (tx) => {
        await checkoutCourseVersion(
          { queryable: tx, withTransaction: (body) => body(tx) },
          { ownerId: OWNER, stageId: STAGE, versionId: original },
        );
        switched.resolve();
        await commit.promise;
      });
      await switched.promise;
      // A reader on another connection still sees the source branch until commit.
      const visible = await pool.query(
        "SELECT data->'content'->>'extra' AS media FROM document_scenes WHERE stage_id=$1 AND id='p2'",
        [STAGE],
      );
      const edit = store.putScene(STAGE, course(STAGE, withExtra('p3', 'hand edit')).scenes[2]!);
      commit.resolve();
      await Promise.all([checkingOut, edit]);
      expect(visible.rows[0].media).toBe('video');
      expect(titles(await store.loadDocument(STAGE))).toEqual([
        'What it is',
        'Light reactions',
        'Calvin cycle+hand edit',
      ]);
      expect((await snapshot())!.id).not.toBe(original);
    });
  });

  /** Every callback reopens the durable, leased tree just as a fresh worker does. */
  async function conversation() {
    const store = new PgAgentSessionStore(db.queryable, { withTransaction: db.withTransaction });
    const sessionId = 'lesson';
    const worker = 'worker-1';
    const meta = await store.createSession({
      id: sessionId,
      ownerId: OWNER,
      prompt: 'lesson',
      stageId: STAGE,
    });
    const claim = await store.claimNextSession(worker, 1, {
      leaseTtlMs: 60_000,
      maxAttempts: 5,
      sessionId,
    });
    const withSession = <T>(work: (deps: CourseVersionDeps) => Promise<T>) =>
      db.withTransaction(async (tx) => {
        const ownerId = await forwardOwnerWrite(tx, OWNER);
        const pinned = agentSessionStoreIn(tx);
        await pinned.assertActiveLease(sessionId, worker, claim!.attempt, tx);
        const handle = await pinned.openEntryTree(sessionId, worker, claim!.attempt);
        return work({
          sessionId,
          ownerId,
          defaultStageId: STAGE,
          session: new Session(AgentSessionEntryStorage.fromHandle(meta, handle)),
          writeEntry: (write) => write(),
          db: { queryable: tx, withTransaction: (body) => body(tx) },
        });
      });
    return {
      message: (text: string, seq?: number) =>
        withSession(({ session }) => appendUser(session, text, seq)),
      reply: (text: string) => withSession(({ session }) => appendAssistant(session, text)),
      record: (phase: 'before_run' | 'after_run', extraStageIds?: string[]) =>
        withSession((deps) => recordCourseVersions(deps, { phase, extraStageIds })),
      entries: () => withSession(({ session }) => session.getEntries()),
      leaf: () => withSession(({ session }) => session.getLeafId()),
      context: () => withSession(({ session }) => session.buildContext()),
      branch: (
        seq: number,
        data: BranchRequestData,
        options: { mediaPending?: boolean; createdStageIds?: Set<string> } = {},
      ) =>
        applyBranchRequests(
          {
            withTransaction: withSession,
            hasPendingMedia: () => options.mediaPending === true,
            createdStageIds: options.createdStageIds,
          },
          [{ seq, data }],
        ),
    };
  }

  describe('branches of a conversation on PostgreSQL', () => {
    it('edits, regenerates and switches with each branch retaining its own hand edits', async () => {
      const doc = documents();
      await doc.saveDocument(course(STAGE, base));
      const session = await conversation();
      await session.message('lesson');
      await session.reply('three pages');
      await session.record('after_run');
      await session.record('before_run');
      const marks = (await session.entries()).filter(
        (e) => e.type === 'custom' && e.customType === COURSE_VERSIONS_ENTRY,
      );
      expect(marks).toHaveLength(1);
      await doc.saveDocument(course(STAGE, withExtra('p1', 'hand edit')));
      await session.record('before_run');
      await session.message('add media', 7);
      await session.reply('video');
      const setMedia = (media: string) =>
        doc.putScene(STAGE, course(STAGE, withExtra('p2', media)).scenes[1]!);
      await setMedia('video');
      await session.record('after_run');

      expect(
        (await session.branch(20, { op: 'regenerate', targetSeq: 7 })).outcomes[0]?.status,
      ).toBe('applied');
      expect(titles(await doc.loadDocument(STAGE))).toEqual([
        'What it is+hand edit',
        'Light reactions',
        'Calvin cycle',
      ]);
      await session.reply('animation');
      await setMedia('animation');
      await session.record('after_run');
      expect(
        (await session.branch(25, { op: 'switch', targetSeq: 7, variant: 'orig' })).outcomes[0]
          ?.status,
      ).toBe('applied');
      expect(titles(await doc.loadDocument(STAGE))[1]).toBe('Light reactions+video');
      const context = await session.context();
      expect(
        context.messages.map((message) => {
          if (message.role === 'user') return message.content;
          if (message.role === 'assistant' && message.content[0]?.type === 'text')
            return message.content[0].text;
          return message.role;
        }),
      ).toEqual(['lesson', 'three pages', 'add media', 'video']);
      await doc.putScene(STAGE, course(STAGE, withExtra('p3', 'note')).scenes[2]!);
      // A retry after checkout but before its lifecycle receipt must not undo this edit.
      expect(
        (await session.branch(25, { op: 'switch', targetSeq: 7, variant: 'orig' })).outcomes[0]
          ?.status,
      ).toBe('applied');
      expect(titles(await doc.loadDocument(STAGE))[2]).toBe('Calvin cycle+note');
      expect(
        (await session.branch(26, { op: 'switch', targetSeq: 7, variant: 'orig' })).outcomes[0]
          ?.status,
      ).toBe('applied');
      expect(titles(await doc.loadDocument(STAGE))[2]).toBe('Calvin cycle+note');
      await session.branch(27, { op: 'switch', targetSeq: 7, variant: 20 });
      expect(titles(await doc.loadDocument(STAGE))).toEqual([
        'What it is+hand edit',
        'Light reactions+animation',
        'Calvin cycle',
      ]);
      await session.branch(28, { op: 'switch', targetSeq: 7, variant: 'orig' });
      expect(titles(await doc.loadDocument(STAGE))).toEqual([
        'What it is+hand edit',
        'Light reactions+video',
        'Calvin cycle+note',
      ]);
      expect((await session.branch(30, { op: 'edit', targetSeq: 7 })).outcomes[0]?.status).toBe(
        'applied',
      );
      expect(titles(await doc.loadDocument(STAGE))).toEqual([
        'What it is+hand edit',
        'Light reactions',
        'Calvin cycle',
      ]);
    });

    it.each([false, true])(
      'checks the missing baseline of a second course (created by this session: %s)',
      async (created) => {
        const doc = documents();
        const session = await conversation();
        await doc.saveDocument(course(STAGE, base));
        if (!created) await doc.saveDocument(course(STAGE_B, base));
        await session.message('make a lesson');
        await session.reply('done');
        await session.record('after_run');
        await session.message('add a video and illustrate it in a second course', 7);
        await session.reply('done');
        for (const id of [STAGE, STAGE_B])
          await doc.saveDocument(course(id, withExtra('p2', 'video')));
        await session.record('after_run', [STAGE_B]);
        const before = await session.leaf();
        const [outcome] = (
          await session.branch(
            20,
            { op: 'regenerate', targetSeq: 7 },
            {
              createdStageIds: new Set(created ? [STAGE_B] : []),
            },
          )
        ).outcomes;
        if (created) {
          expect(outcome?.status).toBe('applied');
          expect(titles(await doc.loadDocument(STAGE))[1]).toBe('Light reactions');
        } else {
          expect(outcome).toMatchObject({ status: 'rejected', reason: 'version_unavailable' });
          expect(await session.leaf()).toBe(before);
          expect(titles(await doc.loadDocument(STAGE))[1]).toBe('Light reactions+video');
        }
        expect(titles(await doc.loadDocument(STAGE_B))[1]).toBe('Light reactions+video');
      },
    );

    it('restores the earliest before-run state of a course first referenced on a later turn', async () => {
      const doc = documents();
      const session = await conversation();
      for (const id of [STAGE, STAGE_B]) await doc.saveDocument(course(id, base));
      await session.message('make a lesson');
      await session.reply('done');
      await session.record('after_run');
      await session.message('change the first course', 7);
      await session.reply('done');
      await doc.saveDocument(course(STAGE, withExtra('p2', 'first')));
      await session.record('after_run');
      await session.record('before_run', [STAGE_B]);
      await session.message('now edit the existing second course', 11);
      await session.reply('done');
      await doc.saveDocument(course(STAGE_B, withExtra('p2', 'second')));
      await session.record('after_run', [STAGE_B]);
      expect(
        (await session.branch(20, { op: 'regenerate', targetSeq: 7 })).outcomes[0]?.status,
      ).toBe('applied');
      for (const id of [STAGE, STAGE_B])
        expect(titles(await doc.loadDocument(id))[1]).toBe('Light reactions');
    });

    it('keeps hand edits to a course only the destination branch has named', async () => {
      const doc = documents();
      const session = await conversation();
      const options = { createdStageIds: new Set([STAGE_B]) };
      await doc.saveDocument(course(STAGE, base));
      await session.message('make a lesson');
      await session.reply('done');
      await session.record('after_run');
      await session.message('create a second course', 7);
      await session.reply('created the second course');
      await doc.saveDocument(course(STAGE_B, withExtra('p2', 'video')));
      await session.record('after_run', [STAGE_B]);
      expect(
        (await session.branch(20, { op: 'regenerate', targetSeq: 7 }, options)).outcomes[0]?.status,
      ).toBe('applied');
      await session.reply('changed only the first course');
      await session.record('after_run');
      await doc.putScene(STAGE_B, course(STAGE_B, withExtra('p2', 'hand edit')).scenes[1]!);
      expect(
        (await session.branch(21, { op: 'switch', targetSeq: 7, variant: 'orig' }, options))
          .outcomes[0]?.status,
      ).toBe('applied');
      expect(titles(await doc.loadDocument(STAGE_B))[1]).toBe('Light reactions+video');
      expect(
        (await session.branch(22, { op: 'switch', targetSeq: 7, variant: 20 }, options)).outcomes[0]
          ?.status,
      ).toBe('applied');
      expect(titles(await doc.loadDocument(STAGE_B))[1]).toBe('Light reactions+hand edit');
    });

    it('rolls back every course and the tree if the second restore fails', async () => {
      const doc = documents();
      const session = await conversation();
      for (const stageId of [STAGE, STAGE_B]) await doc.saveDocument(course(stageId, base));
      await session.message('two lessons');
      await session.reply('three pages each');
      await session.record('after_run', [STAGE_B]);
      await session.message('add videos', 7);
      await session.reply('two videos');
      for (const stageId of [STAGE, STAGE_B])
        await doc.saveDocument(course(stageId, withExtra('p2', 'video')));
      await session.record('after_run');
      const before = await session.leaf();
      const initial = await manifest();
      await pool.query(`ALTER TABLE document_scenes ADD CONSTRAINT reject_second_restore
        CHECK (stage_id <> '${STAGE_B}' OR id <> 'p2' OR data->'content'->>'extra' IS NOT NULL) NOT VALID`);
      try {
        expect(
          (await session.branch(20, { op: 'regenerate', targetSeq: 7 })).outcomes,
        ).toMatchObject([{ status: 'rejected', reason: 'checkout_failed' }]);
      } finally {
        await pool.query('ALTER TABLE document_scenes DROP CONSTRAINT reject_second_restore');
      }
      expect(await session.leaf()).toBe(before);
      expect(await manifest()).toEqual(initial);
      for (const stageId of [STAGE, STAGE_B])
        expect(titles(await doc.loadDocument(stageId))[1]).toBe('Light reactions+video');
      expect(
        (await session.branch(21, { op: 'regenerate', targetSeq: 7 })).outcomes[0]?.status,
      ).toBe('applied');
      for (const stageId of [STAGE, STAGE_B])
        expect(titles(await doc.loadDocument(stageId))[1]).toBe('Light reactions');
    });

    it('leaves a deleted course retired and refuses to switch during pending media', async () => {
      const doc = documents();
      await doc.saveDocument(course(STAGE, base));
      const session = await conversation();
      await session.message('lesson');
      await session.reply('three pages');
      await session.record('after_run');
      await session.message('add media', 7);
      await session.reply('video');
      const before = await session.leaf();
      expect(
        (await session.branch(12, { op: 'regenerate', targetSeq: 7 }, { mediaPending: true }))
          .outcomes[0]?.reason,
      ).toBe('media_pending');
      expect(await session.leaf()).toBe(before);
      await doc.deleteDocument(STAGE);
      expect((await session.branch(13, { op: 'regenerate', targetSeq: 7 })).outcomes).toMatchObject(
        [{ status: 'applied', checkedOut: [{ stageId: STAGE, outcome: 'missing' }] }],
      );
      expect(await doc.loadDocument(STAGE)).toBeNull();
    });

    it('leaves an unversioned historic follow-up and its live course together', async () => {
      const doc = documents();
      await doc.saveDocument(course(STAGE, base));
      const session = await conversation();
      await session.message('lesson');
      await session.reply('three pages');
      await session.message('change page two', 7);
      await session.reply('done');
      const before = await session.leaf();
      expect((await session.branch(20, { op: 'edit', targetSeq: 7 })).outcomes).toMatchObject([
        { status: 'rejected', reason: 'version_unavailable' },
      ]);
      expect(await session.leaf()).toBe(before);
      expect((await pool.query('SELECT id FROM course_versions')).rows).toEqual([]);
      expect(titles(await doc.loadDocument(STAGE))[1]).toBe('Light reactions');
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
      const store = new PgAgentSessionStore(db.queryable, { withTransaction: db.withTransaction });
      const pending = (await readAgentMessageLog(store, 's1')).pendingBranches;
      expect(pending).toEqual([{ seq: 4, data: { op: 'switch', targetSeq: 0, variant: 'orig' } }]);
    });
  });
});
