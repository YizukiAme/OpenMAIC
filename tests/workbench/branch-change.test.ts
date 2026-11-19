import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeWorkbenchBranch, courseForSwitch } from '@/lib/workbench/change-branch';
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

  it('waits for the cancelled server run even when the local fold still looks terminal', async () => {
    vi.useFakeTimers();
    useWorkbenchStore.getState().attach('a', null);
    useWorkbenchStore.setState({ status: 'succeeded' });
    let polled = 0;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith('/cancel'))
          return Response.json({ cancelRequested: true }, { status: 202 });
        if (url.endsWith('/branch')) return Response.json({ requestSeq: 6 }, { status: 202 });
        return Response.json({ status: ++polled === 1 ? 'running' : 'cancelled' });
      }),
    );
    const change = changeWorkbenchBranch(
      'a',
      { op: 'regenerate', targetSeq: 0 },
      { pendingSend: true },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(urls).toEqual(['/api/agent/sessions/a/cancel', '/api/agent/sessions/a']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(urls.at(-1)).toBe('/api/agent/sessions/a/branch');
    useWorkbenchStore.getState().detach();
    await expect(change).resolves.toBeNull();
  });

  it('abandons a waiting action when the user opens another conversation', async () => {
    useWorkbenchStore.getState().attach('a', null);
    let finish!: () => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({}, { status: 202 }));
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const change = changeWorkbenchBranch('a', { op: 'regenerate', targetSeq: 0 });
    useWorkbenchStore.getState().attach('b', null);
    finish();
    await expect(change).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('opens the selected reply’s course even if the outgoing reply created a different one', () => {
    expect(
      courseForSwitch(
        [{ kind: 'course', key: 'e17', text: '', stageIds: ['wanted', 'deleted'] }],
        [
          { stageId: 'older', outcome: 'restored' },
          { stageId: 'wanted', outcome: 'unchanged' },
          { stageId: 'deleted', outcome: 'missing' },
        ],
        'outgoing',
      ),
    ).toBe('wanted');
  });
});
