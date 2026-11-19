import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/agent/sessions/[id]/branch/route';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => true }));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(() => 'owner-1'),
);
vi.mock('@/lib/server/model-config/runtime', () => ({
  assertWorkspaceModelsAuthorized: async () => {},
}));

const contractUrl = process.env.PG_CONTRACT_URL;
describe.skipIf(!contractUrl)('PostgreSQL branch admission', () => {
  const schema = `openmaic_branch_admission_${process.pid}`;
  let admin: Pool;
  let pool: Pool;
  let store: Awaited<ReturnType<typeof getAgentSessionStore>>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(contractUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    vi.stubEnv('DATABASE_URL', url.toString());
    store = await getAgentSessionStore();
    pool = (await getServerPersistenceProvider(url.toString())).pool;
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function prepare(id: string) {
    await store.createSession({
      id,
      ownerId: 'owner-1',
      stageId: 'stage',
      prompt: 'Opening',
      status: 'queued',
    });
    const targetSeq = await store.appendControlEvent(id, {
      type: 'user_message',
      ts: 1,
      data: {
        text: 'First version',
        materials: [{ materialId: 'old-session-copy', originalName: 'lesson.pdf' }],
      },
    });
    const claim = await store.claimNextSession('seed-worker', 1, {
      sessionId: id,
      leaseTtlMs: 60_000,
      maxAttempts: 3,
    });
    await store.markUserMessageDelivered(id, 'seed-worker', claim!.attempt, targetSeq!);
    await store.finishSession(id, 'seed-worker', {
      status: 'succeeded',
      expectedAttempt: claim!.attempt,
    });
    return (text: string) => call(id, { op: 'edit', targetSeq, text });
  }

  function call(id: string, body: Record<string, unknown>) {
    return POST(
      new NextRequest(`http://localhost/api/agent/sessions/${id}/branch`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it('admits one simultaneous edit with its original materials and one queued session', async () => {
    const edit = await prepare('concurrent-edit');
    const responses = await Promise.all([edit('First revision'), edit('Second revision')]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const events = await store.readEventsAfter('concurrent-edit', 1);
    expect(events.map((event) => event.type)).toEqual(['branch_request', 'user_message']);
    expect(events[1]?.data).toMatchObject({
      materials: [{ materialId: 'old-session-copy', originalName: 'lesson.pdf' }],
    });
    expect((await store.getSession('concurrent-edit'))?.status).toBe('queued');
  });

  it('rolls the request and queue back when the edited message cannot be saved', async () => {
    const edit = await prepare('failed-edit');
    await pool.query(
      `ALTER TABLE agent_session_events ADD CHECK (data->>'text' <> 'fail this write')`,
    );
    await edit('fail this write').catch(() => undefined);
    expect(await store.readEventsAfter('failed-edit', 1)).toEqual([]);
    expect((await store.getSession('failed-edit'))?.status).toBe('succeeded');
  });

  it('leaves an unanswered question usable instead of accepting an unclaimable branch', async () => {
    const edit = await prepare('waiting-for-answer');
    await store.appendControlEvent('waiting-for-answer', {
      type: 'user_question',
      ts: 2,
      data: { question: 'Which level?' },
    });
    const response = await edit('Edit my first message');
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'QUESTION_PENDING' });
    expect(await store.getSession('waiting-for-answer')).toMatchObject({
      status: 'succeeded',
      awaitingAnswer: true,
    });
    expect(await store.readEventsAfter('waiting-for-answer', 2)).toEqual([]);
  });

  it('keeps a follow-up stranded by cancellation on the course it was sent to', async () => {
    const id = 'cancelled-with-pending-input';
    const edit = await prepare(id);
    await store.requeueSession(id);
    const claim = await store.claimNextSession('worker', 1, {
      sessionId: id,
      leaseTtlMs: 60_000,
      maxAttempts: 3,
    });
    await store.postUserMessage(id, { text: 'This belongs to the old course' });
    await store.finishSession(id, 'worker', {
      status: 'cancelled',
      expectedAttempt: claim!.attempt,
    });
    const response = await edit('Edit an earlier question');
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'MESSAGE_PENDING' });
    expect((await call(id, { op: 'switch', targetSeq: 0, variant: 'orig' })).status).toBe(409);
    expect((await store.getSession(id))?.status).toBe('cancelled');
  });

  it('allows a new branch after a rejected edit even though that text was never delivered', async () => {
    const id = 'previously-rejected';
    await prepare(id);
    const seq = await store.appendControlEvent(id, {
      ts: 2,
      type: 'branch_request',
      data: { op: 'edit', targetSeq: 1 },
    });
    await store.appendControlEvent(id, {
      ts: 3,
      type: 'user_message',
      data: { text: 'rejected revision' },
    });
    await store.appendControlEvent(id, {
      ts: 4,
      type: 'session_end',
      data: { branches: [{ requestSeq: seq, status: 'rejected' }] },
    });
    expect((await call(id, { op: 'switch', targetSeq: 0, variant: 'orig' })).status).toBe(202);
  });
});
