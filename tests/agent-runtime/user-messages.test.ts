import type { PersistedAgentSessionEvent } from '@openmaic/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  listAgentUserMessages,
  readAgentMessageLog,
} from '@/lib/server/agent-runtime/user-messages';

describe('readAgentMessageLog', () => {
  it('recognizes courses the conversation created when replaying its library receipts', async () => {
    const events = [
      { type: 'library_changed', data: { change: 'stage_created', stageId: 'new-course' } },
      { type: 'library_changed', data: { change: 'stage_renamed', stageId: 'existing-course' } },
    ].map((event, i) => ({ ...event, id: i + 1, ts: 1, attempt: 1 }));
    const log = await readAgentMessageLog(
      { readEventsAfter: async () => events, listUserMessages: async () => [] },
      's',
    );
    expect(log.createdStageIds).toEqual(new Set(['new-course']));
  });

  it('delivers an edit only after its branch was applied, keeping later ordinary messages', async () => {
    const events = [
      { id: 1, type: 'session_start', data: {} },
      { id: 2, type: 'branch_request', data: { op: 'edit', targetSeq: 1 } },
      { id: 3, type: 'user_message', data: { text: 'edited text' } },
      { id: 4, type: 'user_message', data: { text: 'ordinary follow-up' } },
    ] as Array<{ id: number; type: string; data: unknown }>;
    const store = {
      readEventsAfter: async () => events.map((event) => ({ ...event, attempt: 1, ts: 1 })),
      listUserMessages: async () => [],
    };
    const messages = async () => (await listAgentUserMessages(store, 's')).map((m) => m.text);
    expect(await messages()).toEqual(['ordinary follow-up']);
    events.push({
      id: 5,
      type: 'session_end',
      data: { branches: [{ requestSeq: 2, status: 'rejected' }] },
    });
    expect(await messages()).toEqual(['ordinary follow-up']);
    events[4]!.data = { branches: [{ requestSeq: 2, status: 'applied' }] };
    expect(await messages()).toEqual(['edited text', 'ordinary follow-up']);
  });

  it('replays recovery boundaries across pages without losing user message context', async () => {
    const events: PersistedAgentSessionEvent[] = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      ts: 1,
      attempt: 1,
      type: 'trace',
      data: {},
    }));
    events.push(
      {
        id: 501,
        ts: 2,
        attempt: 1,
        type: 'skill_detached',
        data: { skillName: 'my-method', throughMessageSeq: 42 },
      },
      {
        id: 502,
        ts: 3,
        attempt: 0,
        type: 'user_message',
        data: {
          text: '/my-method new selection',
          delivery: 'follow_up',
          materials: [],
          elementRefs: [{ id: 'element-1' }],
          courseRefs: [{ id: 'course-1' }],
          locale: 'zh-CN',
        },
      },
    );
    const store = {
      readEventsAfter: vi.fn(async (_id: string, after: number, limit = 500) =>
        events.filter((event) => event.id > after).slice(0, limit),
      ),
      listUserMessages: vi.fn(async () => []),
    };
    const log = await readAgentMessageLog(store, 'session-1');
    expect(log.detachedSkills).toEqual([{ skillName: 'my-method', throughMessageSeq: 42 }]);
    expect(log.messages).toEqual([
      {
        seq: 502,
        ts: 3,
        text: '/my-method new selection',
        delivery: 'follow_up',
        materials: [],
        elementRefs: [{ id: 'element-1' }],
        courseRefs: [{ id: 'course-1' }],
        locale: 'zh-CN',
      },
    ]);
    expect(store.readEventsAfter).toHaveBeenNthCalledWith(2, 'session-1', 500, 500);
    expect(await listAgentUserMessages(store, 'session-1')).toEqual(log.messages);
    expect(store.listUserMessages).not.toHaveBeenCalled();
  });

  it('ignores malformed recovery receipts', async () => {
    const data = [
      null,
      [],
      {},
      { skillName: 'my-method', throughMessageSeq: -1 },
      { skillName: 'my-method', throughMessageSeq: 1.5 },
    ];
    const store = {
      readEventsAfter: vi.fn(async () =>
        data.map((value, i) => ({
          id: i + 1,
          ts: 1,
          attempt: 1,
          type: 'skill_detached',
          data: value,
        })),
      ),
      listUserMessages: vi.fn(async () => []),
    };
    expect(await readAgentMessageLog(store, 'session-1')).toEqual({
      messages: [],
      detachedSkills: [],
    });
  });

  it.each(['session_start', 'session_resumed', 'session_end', 'session_interrupted'])(
    'does not mistake a follow-up after %s for a durable opener',
    async (type) => {
      const store = {
        readEventsAfter: vi.fn(async () => [
          { id: 1, ts: 1, attempt: 1, type, data: {} },
          { id: 2, ts: 2, attempt: 0, type: 'user_message', data: { text: 'new selection' } },
        ]),
        listUserMessages: vi.fn(async () => []),
      };
      expect(await readAgentMessageLog(store, 'session-1')).not.toHaveProperty('openingMessageSeq');
      store.readEventsAfter.mockResolvedValue([
        { id: 1, ts: 1, attempt: 0, type: 'user_message', data: { text: 'opening context' } },
        { id: 2, ts: 2, attempt: 1, type, data: {} },
      ]);
      expect(await readAgentMessageLog(store, 'session-1')).toHaveProperty('openingMessageSeq', 1);
    },
  );
});
