import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeWorkbenchBranch, panesAfterBranchSwitch } from '@/lib/workbench/change-branch';
import { useWorkbenchStore, type WorkbenchEvent } from '@/lib/workbench/session-store';
import { flushStageSave } from '@/lib/store/stage';

vi.mock('@/lib/store/stage', () => ({ flushStageSave: vi.fn() }));
afterEach(() => {
  useWorkbenchStore.getState().detach();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('changing the selected branch', () => {
  it('saves hand edits before the request and waits for its actual checkout', async () => {
    useWorkbenchStore.getState().attach('session', null);
    useWorkbenchStore.setState({ status: 'succeeded' });
    const calls: string[] = [];
    vi.mocked(flushStageSave).mockImplementation(async () => {
      calls.push('save');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return Response.json({ requestSeq: 8 }, { status: 202 });
      }),
    );
    let settled = false;
    const change = changeWorkbenchBranch('session', {
      op: 'switch',
      targetSeq: 0,
      variant: 'orig',
    }).then((receipt) => {
      settled = true;
      return receipt;
    });
    await vi.waitFor(() => expect(calls).toEqual(['save', '/api/agent/sessions/session/branch']));
    expect(settled).toBe(false);
    const receipt = { requestSeq: 8, op: 'switch', status: 'applied' };
    useWorkbenchStore.getState().applyEvent({
      id: 9,
      type: 'session_end',
      data: { branches: [receipt], status: 'succeeded', note: 'branch requests only' },
      ts: 1,
      attempt: 1,
    } satisfies WorkbenchEvent);
    await expect(change).resolves.toEqual(receipt);
  });

  it.each(['running', 'pending send'] as const)(
    'never cancels a %s reply for a branch action',
    async (phase) => {
      useWorkbenchStore.getState().attach('a', null);
      useWorkbenchStore.setState({ status: phase === 'running' ? 'running' : 'succeeded' });
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      for (const request of [
        { op: 'switch', targetSeq: 1 },
        { op: 'regenerate', targetSeq: 1 },
        { op: 'edit', targetSeq: 1, text: 'edited' },
      ] as const) {
        await expect(
          changeWorkbenchBranch('a', request, { pendingSend: phase === 'pending send' }),
        ).rejects.toMatchObject({ errorCode: 'SESSION_BUSY' });
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(flushStageSave).not.toHaveBeenCalled();
    },
  );

  it('abandons a waiting action when the user opens another conversation', async () => {
    useWorkbenchStore.getState().attach('a', null);
    useWorkbenchStore.setState({ status: 'succeeded' });
    let finish!: () => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({}, { status: 202 }));
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const change = changeWorkbenchBranch('a', { op: 'regenerate', targetSeq: 0 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    useWorkbenchStore.getState().attach('b', null);
    finish();
    await expect(change).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('following a branch in the open classroom', () => {
  const open = { sessionId: 'session', courseId: 'outgoing' };
  const closed = { ...open, courseId: null };
  const chat = [{ kind: 'course' as const, key: 'e17', text: '', stageIds: ['wanted', 'deleted'] }];
  const checkedOut = [
    { stageId: 'older', outcome: 'restored' },
    { stageId: 'wanted', outcome: 'unchanged' },
    { stageId: 'deleted', outcome: 'missing' },
  ];

  it('shows the selected reply’s course in an already open pane', () => {
    expect(panesAfterBranchSwitch(open, open, chat, checkedOut)).toEqual({
      ...open,
      courseId: 'wanted',
    });
  });

  it('leaves a chat-only workspace alone', () => {
    expect(panesAfterBranchSwitch(closed, closed, chat, checkedOut)).toBeNull();
  });

  it('respects navigation while the checkout is pending', () => {
    for (const current of [closed, { ...open, courseId: 'other' }, { ...open, view: 'library' }]) {
      expect(panesAfterBranchSwitch(open, current, chat, checkedOut)).toBeNull();
    }
  });
});
