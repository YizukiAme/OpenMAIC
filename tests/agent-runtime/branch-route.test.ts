import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  postUserMessage: vi.fn(),
  appendControlEvent: vi.fn(),
  requeueSession: vi.fn(),
  readEventsAfter: vi.fn(),
  query: vi.fn(),
  bindOwnerMaterialsToSession: vi.fn(),
  listPendingMediaTasks: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(() => 'owner-1'),
);
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    getSession: mocks.getSession,
    readEventsAfter: mocks.readEventsAfter,
  }),
  agentSessionStoreIn: () => ({
    postUserMessage: mocks.postUserMessage,
    appendControlEvent: mocks.appendControlEvent,
    requeueSession: mocks.requeueSession,
  }),
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    withTransaction: (body: (tx: unknown) => unknown) => body({ query: mocks.query }),
  }),
}));
vi.mock('@/lib/server/agent-runtime/session-materials', () => ({
  getAgentSessionMaterialStore: vi.fn(),
  SessionMaterialBindingError: class SessionMaterialBindingError extends Error {},
  bindOwnerMaterialsToSession: mocks.bindOwnerMaterialsToSession,
}));
vi.mock('@/lib/server/agent-runtime/pending-media', () => ({
  listPendingMediaTasks: mocks.listPendingMediaTasks,
}));

import { POST } from '@/app/api/agent/sessions/[id]/branch/route';

function call(body: unknown) {
  const request = new NextRequest('http://localhost/api/agent/sessions/session-1/branch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: 'session-1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status: 'succeeded' });
  mocks.appendControlEvent.mockResolvedValue(21);
  mocks.requeueSession.mockResolvedValue(true);
  mocks.postUserMessage.mockResolvedValue({ seq: 22, delivery: 'queued', requeued: true });
  mocks.readEventsAfter.mockResolvedValue([
    { id: 7, type: 'user_message', data: { text: 'add a video' } },
  ]);
  mocks.query.mockResolvedValue({ rows: [{ status: 'succeeded' }] });
  mocks.bindOwnerMaterialsToSession.mockResolvedValue([]);
  mocks.listPendingMediaTasks.mockReturnValue([]);
});

describe('POST agent session branch (#1317 prototype)', () => {
  it('makes a regenerate durable and requeues the session', async () => {
    const response = await call({ op: 'regenerate', targetSeq: 7 });
    expect(response.status).toBe(202);
    expect(mocks.appendControlEvent).toHaveBeenCalledWith('session-1', {
      ts: expect.any(Number),
      type: 'branch_request',
      data: { op: 'regenerate', targetSeq: 7 },
    });
    expect(mocks.requeueSession).toHaveBeenCalledWith('session-1');
    expect(mocks.postUserMessage).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      id: 'session-1',
      requestSeq: 21,
      op: 'regenerate',
    });
  });

  it('posts the edited text after the request, which requeues the session', async () => {
    const response = await call({ op: 'edit', targetSeq: 7, text: ' add a quiz instead ' });
    expect(response.status).toBe(202);
    expect(mocks.appendControlEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.postUserMessage.mock.invocationCallOrder[0]!,
    );
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      { text: 'add a quiz instead' },
      { expectedOwnerId: 'owner-1' },
    );
    expect(mocks.requeueSession).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      id: 'session-1',
      requestSeq: 21,
      op: 'edit',
      message: { seq: 22, text: 'add a quiz instead' },
    });
  });

  it('switches to a reply variant', async () => {
    const response = await call({ op: 'switch', targetSeq: 7, variant: 'orig' });
    expect(response.status).toBe(202);
    expect(mocks.appendControlEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ data: { op: 'switch', targetSeq: 7, variant: 'orig' } }),
    );
  });

  it('refuses while a run is writing, without touching the log', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status: 'running' });
    const response = await call({ op: 'switch', targetSeq: 7 });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_BUSY' });
    expect(mocks.appendControlEvent).not.toHaveBeenCalled();
  });

  it('refuses while the conversation still has media generating', async () => {
    mocks.listPendingMediaTasks.mockReturnValue([
      { ref: 'gen_vid_1', sessionId: 'session-1', status: 'generating' },
    ]);
    const response = await call({ op: 'regenerate', targetSeq: 7 });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'MEDIA_PENDING' });
  });

  it('rejects malformed requests, unknown targets and editing the opening prompt', async () => {
    expect((await call({ op: 'merge', targetSeq: 7 })).status).toBe(400);
    expect((await call({ op: 'edit', targetSeq: 7 })).status).toBe(400);
    expect((await call({ op: 'edit', targetSeq: 0, text: 'x' })).status).toBe(400);
    expect((await call({ op: 'regenerate', targetSeq: 99 })).status).toBe(404);
    expect(mocks.appendControlEvent).not.toHaveBeenCalled();
  });

  it("hides another owner's session", async () => {
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      ownerId: 'owner-2',
      status: 'succeeded',
    });
    expect((await call({ op: 'regenerate', targetSeq: 7 })).status).toBe(404);
  });
});
