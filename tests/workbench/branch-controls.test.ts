// @vitest-environment jsdom
/**
 * Edit-and-resend controls on the timeline (#1317 prototype): a conversation
 * that never branched renders as it always did; forks show their position;
 * a stopped reply keeps the run's own caption; the live reply has no controls.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { UserBubbleEditor } from '@/components/workbench/chat/branch-controls';
import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import { defaultWorkbenchTranslator } from '@/lib/i18n/workbench';
import { COMPOSER_INPUT, setComposerText } from './_composer-driver';
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));

import { ChatTimeline, type TimelineBranch } from '@/components/workbench/chat/chat-timeline';
import { projectBranchChat } from '@/lib/workbench/branch-fold';
import {
  foldEvent,
  useWorkbenchStore,
  type WorkbenchEvent,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';

let seq = 0;
function ev(type: string, data: unknown, attempt = 0): WorkbenchEvent {
  seq += 1;
  return { id: seq, ts: 1000 + seq, attempt, type, data };
}
const reply = (text: string): WorkbenchEvent[] => [
  ev('message_start', { message: { role: 'assistant', content: [] } }),
  ev('message_end', { message: { role: 'assistant', content: [{ type: 'text', text }] } }),
];

const blankFold = {
  status: 'connecting',
  lastEventId: 0,
  error: null,
  courseTitle: null,
  sessionPrompt: null,
  sessionTitle: null,
  skillId: null,
  skillViolations: [],
  plan: [],
  pages: {},
  chat: [],
  libraryRevision: 0,
  materialLibraryRevision: 0,
  stageLinkStageIds: [],
  touchedStageIds: [],
  runCourseStageIds: [],
  generatingOrder: null,
  panelOpen: false,
  panelPinned: false,
  thinkingKey: null,
  assistantKey: null,
  generationOpen: false,
  epoch: 0,
  waitingKey: null,
  waitingArmed: false,
  stageId: null,
} as WorkbenchFold;

function render(state: WorkbenchFold, turnActive = false, withBranch = true) {
  const view = projectBranchChat(state.chat, state.branch!);
  const branch: TimelineBranch = {
    segments: view.segments,
    forks: view.forks,
    disabled: false,
    browsingOnly: turnActive,
    onEdit: async () => true,
    onRegenerate: () => {},
    onSwitchUser: () => {},
    onSwitchReply: () => {},
  };
  return renderToStaticMarkup(
    createElement(ChatTimeline, {
      chat: view.chat,
      plan: [],
      turnActive,
      ...(withBranch ? { branch } : {}),
    }),
  );
}

function base() {
  seq = 0;
  return [
    ev('session_start', { prompt: 'make a lesson' }, 1),
    ...reply('three pages'),
    ev('session_end', { status: 'succeeded' }, 1),
    ev('user_message', { text: 'add a video', delivery: 'queued' }),
    ...reply('video added'),
    ev('session_end', { status: 'succeeded' }, 1),
  ];
}

describe('branch controls on the timeline', () => {
  it('can send the retry requested by a failed runner while a durable branch request awaits a receipt', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const fetch = vi.fn(async (url: string) =>
      Response.json(url === '/api/agent/skills' ? [] : {}),
    );
    vi.stubGlobal('fetch', fetch);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      const store = useWorkbenchStore.getState();
      store.attach('session', null);
      store.applyEvents([
        ...base(),
        ev('branch_request', { op: 'regenerate', targetSeq: 0 }),
        ev('session_end', { status: 'failed', error: 'Send a new message to retry' }, 1),
      ]);
      store.finishReplay();
      await act(async () => root.render(createElement(WorkbenchChat, { hosted: true })));
      await act(async () => setComposerText(container.querySelector(COMPOSER_INPUT)!, 'Continue'));
      const send = container.querySelector<HTMLButtonElement>('[data-testid="workbench-send"]')!;
      expect(send.disabled).toBe(false);
      await act(async () => send.click());
      expect(fetch).toHaveBeenCalledWith(
        '/api/agent/sessions/session/messages',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useWorkbenchStore.getState().detach();
      vi.unstubAllGlobals();
    }
  });
  it('adds nothing but the regenerate and edit buttons to a linear conversation', () => {
    const state = base().reduce(foldEvent, blankFold);
    const html = render(state);
    expect(html).not.toContain('data-testid="branch-switcher"');
    // Two replies, each with its regenerate button; one editable follow-up.
    expect(html.match(/data-testid="branch-reply-controls"/g)).toHaveLength(2);
    expect(html.match(/data-testid="branch-user-controls"/g)).toHaveLength(1);
    // Without branch props the timeline is the one it always was.
    expect(render(state, false, false)).not.toContain('branch-');
  });

  it('shows where a regenerated reply sits among its versions', () => {
    const events = base();
    const userSeq = events.find((event) => event.type === 'user_message')!.id;
    const regenerate = ev('branch_request', { op: 'regenerate', targetSeq: userSeq });
    const state = [
      ...events,
      regenerate,
      ev(
        'session_resumed',
        {
          reason: 'follow_up',
          branches: [{ requestSeq: regenerate.id, op: 'regenerate', status: 'applied' }],
        },
        1,
      ),
      ...reply('animation added'),
      ev('session_end', { status: 'cancelled' }, 1),
    ].reduce(foldEvent, blankFold);
    const html = render(state);
    expect(html).toContain('data-testid="branch-switcher"');
    expect(html).toContain('>2 / 2<');
    expect(html).toContain('data-testid="workbench-run-boundary"');
  });

  it('keeps the switcher reachable when one reply has no visible rows', () => {
    seq = 0;
    const state = [
      ev('session_start', { prompt: 'lesson' }, 1),
      ...reply('an answer'),
      ev('session_end', { status: 'succeeded' }, 1),
      ev('branch_request', { op: 'regenerate', targetSeq: 0 }),
      ev(
        'session_resumed',
        { reason: 'follow_up', branches: [{ requestSeq: 5, op: 'regenerate', status: 'applied' }] },
        1,
      ),
      ev('agent_end', {}),
      ev('session_end', { status: 'succeeded' }, 1),
    ].reduce(foldEvent, blankFold);
    expect(render(state)).toContain('>2 / 2<');
  });

  it('only offers edit on follow-ups when the opening bubble had attachments', () => {
    seq = 0;
    const state = [
      ev('user_message', {
        text: 'Lesson',
        materials: [{ materialId: 'm1', originalName: 'lesson.pdf' }],
      }),
      ev('session_start', { prompt: 'Lesson' }, 1),
      ...reply('an answer'),
      ev('session_end', { status: 'succeeded' }, 1),
    ].reduce(foldEvent, blankFold);
    expect(render(state)).not.toContain('data-testid="branch-user-controls"');
  });

  it('leaves only version browsing available during a run', () => {
    seq = 0;
    const state = [ev('session_start', { prompt: 'make a lesson' }, 1), ...reply('writing')].reduce(
      foldEvent,
      blankFold,
    );
    expect(render(state, true)).not.toContain('data-testid="branch-reply-controls"');

    // A running conversation without forks offers no branch actions.
    const live = [
      ...base(),
      ev('user_message', { text: 'one more page', delivery: 'queued' }),
      ...reply('writing page 4'),
    ].reduce(foldEvent, blankFold);
    const html = render(live, true);
    expect(html).not.toContain('data-testid="branch-reply-controls"');
    expect(html).not.toContain('data-testid="branch-user-controls"');
  });
});

it('keeps the typed edit when refused and lets the Chinese input method finish before submitting', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const submit = vi.fn(async () => false);
  try {
    await act(async () =>
      root.render(
        createElement(UserBubbleEditor, {
          initialText: 'Old',
          hasAttachments: true,
          onCancel: () => {},
          onSubmit: submit,
          t: defaultWorkbenchTranslator,
        }),
      ),
    );
    const area = container.querySelector('textarea')!;
    expect(container.textContent).toContain('保留原附件');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        area,
        '改成选择题',
      );
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const press = (keyCode: number) =>
      act(async () => {
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode, bubbles: true }));
      });
    await press(229);
    expect(submit).not.toHaveBeenCalled();
    await press(13);
    expect(submit).toHaveBeenCalledWith('改成选择题');
    expect(area.value).toBe('改成选择题');
    // The same editor can send just the retained file, as the normal composer can.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(13);
    expect(submit).toHaveBeenLastCalledWith('');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
