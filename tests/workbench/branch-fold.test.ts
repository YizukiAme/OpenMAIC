/**
 * Branches folded from the event log (#1317 prototype): the transcript on
 * screen is the selected path through user messages and their replies, and a
 * replayed log folds to the same branches as a live one.
 */
import { describe, expect, it } from 'vitest';

import { projectBranchChat, userSeqOfNodeKey } from '@/lib/workbench/branch-fold';
import { foldEvent, type WorkbenchEvent, type WorkbenchFold } from '@/lib/workbench/session-store';

let seq = 0;
function ev(type: string, data: unknown, attempt = 0): WorkbenchEvent {
  seq += 1;
  return { id: seq, ts: 1000 + seq, attempt, type, data };
}

const blankFold: WorkbenchFold = {
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
};

const reply = (text: string): WorkbenchEvent[] => [
  ev('message_start', { message: { role: 'assistant', content: [] } }),
  ev('message_end', { message: { role: 'assistant', content: [{ type: 'text', text }] } }),
];

/** The words on screen: user bubbles and assistant prose, in order. */
function onScreen(state: WorkbenchFold): string[] {
  return projectBranchChat(state.chat, state.branch!)
    .chat.filter((node) => node.kind === 'user' || node.kind === 'assistant')
    .map((node) => (node.kind === 'user' ? `> ${node.text}` : node.text));
}

function forkOf(state: WorkbenchFold, text: string) {
  const view = projectBranchChat(state.chat, state.branch!);
  const node = view.chat.find((candidate) => candidate.text === text)!;
  const fork = view.forks.get(node.segment!);
  return fork ? `${fork.index + 1}/${fork.count}` : null;
}

describe('branch fold', () => {
  function conversation() {
    seq = 0;
    const events: WorkbenchEvent[] = [
      ev('session_start', { prompt: 'make a photosynthesis lesson' }, 1),
      ...reply('outline and three pages'),
      ev('session_end', { status: 'succeeded' }, 1),
      ev('user_message', { text: 'add a video to page 2', delivery: 'queued' }),
      ev('session_resumed', { reason: 'follow_up' }, 1),
      ...reply('added a video'),
      ev('session_end', { status: 'succeeded' }, 1),
    ];
    return events;
  }

  it('names user messages by their durable sequence and the opening prompt by 0', () => {
    expect(userSeqOfNodeKey('e12')).toBe(12);
    expect(userSeqOfNodeKey('e1-u')).toBe(0);
    expect(userSeqOfNodeKey('e3-w')).toBeUndefined();
  });

  it('shows a linear conversation as it always did', () => {
    const state = conversation().reduce(foldEvent, blankFold);
    expect(onScreen(state)).toEqual([
      '> make a photosynthesis lesson',
      'outline and three pages',
      '> add a video to page 2',
      'added a video',
    ]);
    expect(forkOf(state, 'added a video')).toBeNull();
  });

  it('puts a regenerated reply beside the original, and switches between them', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    const regenerate = ev('branch_request', { op: 'regenerate', targetSeq: userSeq });
    const events = [
      ...base,
      regenerate,
      ev('session_resumed', { reason: 'follow_up', branches: [{ requestSeq: regenerate.id }] }, 1),
      ...reply('added an animation'),
      ev('session_end', { status: 'succeeded' }, 1),
    ];
    let state = events.reduce(foldEvent, blankFold);
    expect(onScreen(state)).toEqual([
      '> make a photosynthesis lesson',
      'outline and three pages',
      '> add a video to page 2',
      'added an animation',
    ]);
    expect(forkOf(state, 'added an animation')).toBe('2/2');

    state = foldEvent(
      state,
      ev('branch_request', { op: 'switch', targetSeq: userSeq, variant: 'orig' }),
    );
    state = foldEvent(
      state,
      ev('session_end', { status: 'succeeded', note: 'branch requests only' }, 1),
    );
    expect(onScreen(state).at(-1)).toBe('added a video');
    expect(forkOf(state, 'added a video')).toBe('1/2');

    // A message sent now continues the branch on screen.
    state = foldEvent(state, ev('user_message', { text: 'make it shorter', delivery: 'queued' }));
    expect(onScreen(state).slice(-2)).toEqual(['added a video', '> make it shorter']);
  });

  it('puts an edited message beside the original with its own reply', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    const events = [
      ...base,
      ev('branch_request', { op: 'edit', targetSeq: userSeq }),
      ev('user_message', { text: 'add a quiz to page 2', delivery: 'queued' }),
      ev('session_resumed', { reason: 'follow_up' }, 1),
      ...reply('added a quiz'),
      ev('session_end', { status: 'succeeded' }, 1),
    ];
    let state = events.reduce(foldEvent, blankFold);
    expect(onScreen(state)).toEqual([
      '> make a photosynthesis lesson',
      'outline and three pages',
      '> add a quiz to page 2',
      'added a quiz',
    ]);
    expect(forkOf(state, 'add a quiz to page 2')).toBe('2/2');

    state = foldEvent(state, ev('branch_request', { op: 'switch', targetSeq: userSeq }));
    expect(onScreen(state).slice(-2)).toEqual(['> add a video to page 2', 'added a video']);
  });

  it('remembers that a reply was stopped, and a switch does not overwrite it', () => {
    seq = 0;
    const events = [
      ev('session_start', { prompt: 'lesson' }, 1),
      ...reply('starting'),
      ev('session_end', { status: 'cancelled' }, 1),
    ];
    let state = events.reduce(foldEvent, blankFold);
    const view = projectBranchChat(state.chat, state.branch!);
    const stopped = view.chat.find((node) => node.text === 'starting')!;
    expect(state.branch!.segments[stopped.segment!]?.endStatus).toBe('cancelled');
    state = foldEvent(
      state,
      ev('session_end', { status: 'succeeded', note: 'branch requests only' }, 1),
    );
    expect(state.branch!.segments[stopped.segment!]?.endStatus).toBe('cancelled');
  });

  it('undoes a request the runner rejected, and says so', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    let state = [
      ...base,
      ev('branch_request', { op: 'regenerate', targetSeq: userSeq }),
      ...reply('added an animation'),
    ].reduce(foldEvent, blankFold);
    const switchRequest = ev('branch_request', {
      op: 'switch',
      targetSeq: userSeq,
      variant: 'orig',
    });
    state = foldEvent(state, switchRequest);
    expect(onScreen(state).at(-1)).toBe('added a video');
    state = foldEvent(
      state,
      ev(
        'session_end',
        {
          status: 'succeeded',
          note: 'branch requests only',
          branches: [{ requestSeq: switchRequest.id, status: 'rejected', reason: 'media_pending' }],
        },
        1,
      ),
    );
    expect(onScreen(state).at(-1)).toBe('added an animation');
    expect(state.chat.at(-1)).toMatchObject({
      kind: 'system',
      copyKey: 'workbench.system.branchRejected',
    });
  });

  it('shows an edit the runner could not put in place as a new message, and says so', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    const edit = ev('branch_request', { op: 'edit', targetSeq: userSeq });
    let state = [
      ...base,
      edit,
      ev('user_message', { text: 'add an animation to page 2', delivery: 'queued' }),
    ].reduce(foldEvent, blankFold);
    expect(forkOf(state, 'add an animation to page 2')).toBe('2/2');

    state = [
      ev(
        'session_resumed',
        {
          reason: 'follow_up',
          branches: [
            { requestSeq: edit.id, op: 'edit', status: 'rejected', reason: 'checkout_failed' },
          ],
        },
        1,
      ),
      ...reply('added an animation'),
      ev('session_end', { status: 'succeeded' }, 1),
    ].reduce(foldEvent, state);

    // The runner delivered it at the end of the branch it stayed on; so does the rail.
    expect(onScreen(state)).toEqual([
      '> make a photosynthesis lesson',
      'outline and three pages',
      '> add a video to page 2',
      'added a video',
      '> add an animation to page 2',
      'added an animation',
    ]);
    expect(forkOf(state, 'add a video to page 2')).toBeNull();
    const notice = projectBranchChat(state.chat, state.branch!).chat.find(
      (node) => node.kind === 'system',
    );
    expect(notice).toMatchObject({ copyKey: 'workbench.system.branchEditSentAsNew' });
  });

  it('says when a version could not be restored, and when putting it back failed too', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    const outcomeOf = (extra: Record<string, unknown>) => {
      seq = base.length;
      const regenerate = ev('branch_request', { op: 'regenerate', targetSeq: userSeq });
      const end = ev(
        'session_end',
        {
          status: 'succeeded',
          note: 'branch requests only',
          branches: [{ requestSeq: regenerate.id, op: 'regenerate', status: 'rejected', ...extra }],
        },
        1,
      );
      const state = [...base, regenerate, end].reduce(foldEvent, blankFold);
      expect(onScreen(state).at(-1)).toBe('added a video');
      return state.chat.at(-1);
    };
    expect(outcomeOf({ reason: 'checkout_failed' })).toMatchObject({
      copyKey: 'workbench.system.branchNotApplied',
    });
    expect(outcomeOf({ reason: 'apply_failed', rollbackFailed: true })).toMatchObject({
      copyKey: 'workbench.system.branchRollbackFailed',
    });
  });

  it('folds a replayed log to the same branches', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    const events = [
      ...base,
      ev('branch_request', { op: 'regenerate', targetSeq: userSeq }),
      ...reply('added an animation'),
    ];
    const live = events.reduce(foldEvent, blankFold);
    const replayed = events.reduce(foldEvent, blankFold);
    expect(replayed.branch).toEqual(live.branch);
    expect(onScreen(replayed)).toEqual(onScreen(live));
  });
});
