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

function applied(request: WorkbenchEvent) {
  const { op } = request.data as { op: string };
  const branches = [{ requestSeq: request.id, status: 'applied', op }];
  return op === 'switch'
    ? ev('session_end', { status: 'succeeded', note: 'branch requests only', branches }, 1)
    : ev('session_resumed', { reason: 'follow_up', branches }, 1);
}
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

  it('resolves opening prompt sequence zero for an opening bubble persisted with materials', () => {
    seq = 0;
    const events = [
      ev('user_message', {
        text: 'lesson',
        materials: [{ materialId: 'm', originalName: 'lesson.pdf' }],
      }),
      ev('session_start', { prompt: 'lesson' }, 1),
      ...reply('first'),
      ev('session_end', { status: 'succeeded' }, 1),
    ];
    const regen = ev('branch_request', { op: 'regenerate', targetSeq: 0 });
    const state = [...events, regen, applied(regen), ...reply('second')].reduce(
      foldEvent,
      blankFold,
    );
    expect(onScreen(state)).toEqual(['> lesson', 'second']);
    expect(forkOf(state, 'second')).toBe('2/2');
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
      applied(regenerate),
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

    const pick = ev('branch_request', { op: 'switch', targetSeq: userSeq, variant: 'orig' });
    state = [pick, applied(pick)].reduce(foldEvent, state);
    expect(onScreen(state).at(-1)).toBe('added a video');
    expect(forkOf(state, 'added a video')).toBe('1/2');

    // A message sent now continues the branch on screen.
    state = foldEvent(state, ev('user_message', { text: 'make it shorter', delivery: 'queued' }));
    expect(onScreen(state).slice(-2)).toEqual(['added a video', '> make it shorter']);
  });

  it('puts an edited message beside the original with its own reply', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    const edit = ev('branch_request', { op: 'edit', targetSeq: userSeq });
    const events = [
      ...base,
      edit,
      ev('user_message', { text: 'add a quiz to page 2', delivery: 'queued' }),
      applied(edit),
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

    const pick = ev('branch_request', { op: 'switch', targetSeq: userSeq });
    state = [pick, applied(pick)].reduce(foldEvent, state);
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

  it('keeps the selected branch when the runner rejects a request and explains why', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    const regen = ev('branch_request', { op: 'regenerate', targetSeq: userSeq });
    let state = [...base, regen, applied(regen), ...reply('added an animation')].reduce(
      foldEvent,
      blankFold,
    );
    const switchRequest = ev('branch_request', {
      op: 'switch',
      targetSeq: userSeq,
      variant: 'orig',
    });
    state = foldEvent(state, switchRequest);
    expect(onScreen(state).at(-1)).toBe('added an animation');
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
      copyKey: 'workbench.chat.branchMediaPending',
    });
  });

  it('keeps a refused edit out of the conversation and preserves the original active question', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    base.push(ev('user_question', { question: 'Make another page?' }));
    const edit = ev('branch_request', { op: 'edit', targetSeq: userSeq });
    const state = [
      ...base,
      edit,
      ev('user_message', { text: 'Rejected edit', delivery: 'queued' }),
      ev(
        'session_end',
        {
          status: 'succeeded',
          note: 'branch requests only',
          branches: [
            { requestSeq: edit.id, op: 'edit', status: 'rejected', reason: 'checkout_failed' },
          ],
        },
        1,
      ),
    ].reduce(foldEvent, blankFold);
    expect(state.chat.some((node) => node.text === 'Rejected edit')).toBe(false);
    expect(state.chat.find((node) => node.kind === 'question')?.questionAnswered).toBeFalsy();
    expect(onScreen(state).at(-1)).toBe('added a video');
    expect(forkOf(state, 'add a video to page 2')).toBeNull();
    expect(state.chat.at(-1)).toMatchObject({ copyKey: 'workbench.system.branchNotApplied' });
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

  it('shows the selected course and keeps other-tab follow-ups on the branch that was applied', () => {
    const events = conversation();
    const userSeq = events.find((e) => e.type === 'user_message')!.id;
    events.push(
      ev('checkpoint', {
        kind: 'outline',
        outline: [{ order: 1, title: 'List' }],
        courseTitle: 'List',
      }),
    );
    const regen = ev('branch_request', { op: 'regenerate', targetSeq: userSeq });
    events.push(
      regen,
      ev(
        'session_resumed',
        {
          reason: 'follow_up',
          branches: [{ requestSeq: regen.id, op: 'regenerate', status: 'applied' }],
        },
        1,
      ),
      ...reply('added a quiz'),
      ev('checkpoint', {
        kind: 'outline',
        outline: [{ order: 1, title: 'Quiz' }],
        courseTitle: 'Quiz',
      }),
      ev('session_end', { status: 'succeeded' }, 1),
    );
    const pick = ev('branch_request', { op: 'switch', targetSeq: userSeq, variant: 'orig' });
    events.push(
      pick,
      ev('user_message', { text: 'continue', delivery: 'queued' }),
      ev(
        'session_resumed',
        {
          reason: 'follow_up',
          branches: [{ requestSeq: pick.id, op: 'switch', status: 'applied' }],
        },
        1,
      ),
    );
    const selected = events.reduce(foldEvent, blankFold);
    expect(selected.chat.filter((n) => n.kind === 'assistant').map((n) => n.text)).toEqual([
      'outline and three pages',
      'added a video',
    ]);
    expect(onScreen(selected).at(-1)).toBe('> continue');
    expect(selected.courseTitle).toBe('List');
  });

  it('folds a replayed log to the same branches', () => {
    const base = conversation();
    const userSeq = base.find((event) => event.type === 'user_message')!.id;
    const regen = ev('branch_request', { op: 'regenerate', targetSeq: userSeq });
    const events = [...base, regen, applied(regen), ...reply('added an animation')];
    const live = events.reduce(foldEvent, blankFold);
    const replayed = events.reduce(foldEvent, blankFold);
    expect(replayed.branch).toEqual(live.branch);
    expect(onScreen(replayed)).toEqual(onScreen(live));
  });
});
