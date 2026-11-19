/**
 * Edit-and-resend controls on the timeline (#1317 prototype): a conversation
 * that never branched renders as it always did; forks show their position;
 * a stopped reply keeps the run's own caption; the live reply has no controls.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatTimeline, type TimelineBranch } from '@/components/workbench/chat/chat-timeline';
import { projectBranchChat } from '@/lib/workbench/branch-fold';
import { foldEvent, type WorkbenchEvent, type WorkbenchFold } from '@/lib/workbench/session-store';

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
    const state = [
      ...events,
      ev('branch_request', { op: 'regenerate', targetSeq: userSeq }),
      ...reply('animation added'),
      ev('session_end', { status: 'cancelled' }, 1),
    ].reduce(foldEvent, blankFold);
    const html = render(state);
    expect(html).toContain('data-testid="branch-switcher"');
    expect(html).toContain('>2 / 2<');
    expect(html).toContain('data-testid="workbench-run-boundary"');
  });

  it('keeps controls off the reply that is still being written, and only that one', () => {
    seq = 0;
    const state = [ev('session_start', { prompt: 'make a lesson' }, 1), ...reply('writing')].reduce(
      foldEvent,
      blankFold,
    );
    expect(render(state, true)).not.toContain('data-testid="branch-reply-controls"');

    // Earlier replies and messages stay usable while a run writes: a request
    // made now stops the run first.
    const live = [
      ...base(),
      ev('user_message', { text: 'one more page', delivery: 'queued' }),
      ...reply('writing page 4'),
    ].reduce(foldEvent, blankFold);
    const html = render(live, true);
    expect(html.match(/data-testid="branch-reply-controls"/g)).toHaveLength(2);
    expect(html.match(/data-testid="branch-user-controls"/g)).toHaveLength(2);
  });
});
