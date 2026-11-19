/**
 * The runner's side of edit-and-resend (#1317 prototype), with a REAL
 * `runSession` loop and a fake Agent (harness shared with runner-wakeup):
 *
 *  1. a claim made only to switch branches settles without prompting the
 *     model, and its session_end carries the branch receipt;
 *  2. so does a claim whose request was turned down, even when the branch the
 *     conversation stays on stopped mid-reply;
 *  3. a regenerate continues the branch it moved to, and the first lifecycle
 *     frame carries the receipt;
 *  4. course versions are recorded before a new user turn and after the run.
 */
import type { AgentOptions } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => {
  // The drain refuses to steer without a matching lease, and WORKER_ID is a
  // random-per-process value. Capture it from the first appendRunEvent call
  // (the runner passes WORKER_ID as its second argument) and hand it back
  // through getSession so `leaseMatches` sees a live, owned session.
  const history = {
    started: false,
    events: [] as Array<{ id: number; ts: number; attempt: number; type: string; data: unknown }>,
  };
  let workerId: string | undefined;
  let sessionId = 'session-wake';
  let deliveredUserMessageSeq = 0;
  const recordWorker = async (_id: string, worker: string, _event?: { type?: string }) => {
    workerId = worker;
    sessionId = _id;
    return 1;
  };
  const store = {
    appendRunEvent: vi.fn(recordWorker),
    pruneMessageUpdates: vi.fn(async () => 0),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () =>
      workerId
        ? {
            id: sessionId,
            ownerId: 'owner-1',
            status: 'running',
            attempt: 1,
            deliveredUserMessageSeq,
            lease: { workerId, workerPid: process.pid, heartbeatAt: Date.now() },
          }
        : null,
    ),
    // The event log as the runner reads it: the user messages listUserMessages
    // models, as `user_message` events, and no earlier run.
    readEventsAfter: vi.fn(async (sessionId: string, afterSeq: number) =>
      afterSeq > 0
        ? []
        : [
            ...history.events,
            ...(history.started
              ? [{ id: 1, ts: 1, attempt: 1, type: 'run_started', data: {} }]
              : []),
            ...(await store.listUserMessages(sessionId)).map((message) => ({
              id: message.seq,
              ts: message.ts,
              attempt: 1,
              type: 'user_message',
              data: {
                text: message.text,
                delivery: message.delivery,
                materials: message.materials,
                locale: message.locale,
              },
            })),
          ].sort((a, b) => a.id - b.id),
    ),
    heartbeat: vi.fn(async () => true),
    markUserMessageDelivered: vi.fn(async (_id, _worker, _attempt, messageSeq: number) => {
      deliveredUserMessageSeq = Math.max(deliveredUserMessageSeq, messageSeq);
      return true;
    }),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(
      async (
        _sessionId?: string,
      ): Promise<
        Array<{
          seq: number;
          ts: number;
          text: string;
          delivery: string;
          materials: unknown[];
          locale?: string;
        }>
      > => [],
    ),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
  const bus = {
    route: undefined as undefined | { kind: string; sessionId: string },
    wake: undefined as undefined | (() => void),
    unsubscribeWakeup: vi.fn(),
  };
  return {
    store,
    bus,
    teachingClosed: false,
    /** Transcript the next run finds in its entry tree (a run cut off mid-turn). */
    entrySeed: [] as unknown[],
    history,
    tree: undefined as import('@earendil-works/pi-agent-core').Session | undefined,
    /** The default event append; a test that replaces it leaves it replaced. */
    recordWorker,
    resetWorker: () => {
      workerId = undefined;
      deliveredUserMessageSeq = 0;
      store.appendRunEvent.mockImplementation(async (id, worker) => {
        workerId = worker;
        sessionId = id;
        return 1;
      });
    },
  };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: vi.fn(async () => mocks.store),
}));

vi.mock('@/lib/server/pbl-v3/runner-tools', () => ({
  teachingRunnerConfig: vi.fn(async () => ({
    systemPrompt: 'Teaching test',
    preloadMessages: () => [],
    tools: [],
    allowedToolNames: new Set(),
    thinkingConfig: { enabled: true, effort: 'low' },
    isTurnComplete: () => mocks.teachingClosed,
    needsTurnReceipt: () => false,
  })),
  withTeachingTurnBoundary: (stream: unknown) => stream,
}));

vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  subscribeAgentEventWakeup: vi.fn(
    (route: { kind: string; sessionId: string }, wake: () => void) => {
      mocks.bus.route = route;
      mocks.bus.wake = wake;
      return mocks.bus.unsubscribeWakeup;
    },
  ),
}));

// The runner lists the session's materials to build the materials prompt
// block. No material store exists in this harness; an empty list keeps the
// prompt free of the block while the real tool builders stay loaded.
vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: vi.fn(async () => []) };
});
// The runner lists what the session reaches through the shared resolver;
// links need a database these tests do not have.
vi.mock('@/lib/server/agent-runtime/material-resolver', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/material-resolver')>();
  return {
    ...actual,
    listSessionScopeMaterials: vi.fn(async () => []),
  };
});

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  const { InMemorySessionRepo, Session } = await import('@earendil-works/pi-agent-core');
  return {
    ...actual,
    AgentSessionEntryStorage: {
      open: async ({ sessionId }: { sessionId: string }) => {
        const storage = (await new InMemorySessionRepo().create({ id: sessionId })).getStorage();
        mocks.tree = new Session(storage);
        if (mocks.entrySeed.length) {
          const seeded = new Session(storage);
          for (const message of mocks.entrySeed.splice(0)) {
            const custom = message as { customType?: string; data?: unknown };
            if (custom.customType) await seeded.appendCustomEntry(custom.customType, custom.data);
            else await seeded.appendMessage(message as never);
          }
        }
        return storage;
      },
    },
  };
});

// No installed skills and no user-skill store: the skill surface is
// orthogonal to the wakeup under test.
vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return {
    ...actual,
    listSkills: vi.fn(async () => []),
    findSkill: vi.fn(async () => null),
  };
});
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

// The owner-bound document store is setup-only in this harness; the tools
// built around it are never invoked.
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getBackgroundDocumentStore: vi.fn(async () => ({})),
}));

// Capability resolution stays hermetic: no web search and no voice
// registration backend in this harness.
vi.mock('@/lib/server/agent-runtime/web-search', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/web-search')>();
  return { ...actual, resolveWebSearchCapability: () => null };
});
vi.mock('@/lib/server/agent-runtime/voice-clone-tools', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/voice-clone-tools')>();
  return { ...actual, hasConfiguredVoiceRegistrationCapability: () => false };
});

// A resolvable driver model with a no-op streamFn: the fake Agent below never
// reads the stream, so nothing touches a real model gateway.
vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: vi.fn(async () => ({
    connection: { model: { id: 'wakeup-test' }, modelId: 'wakeup-test', providerId: 'test' },
    piModel: {
      id: 'wakeup-test',
      name: 'wakeup-test',
      api: 'openai-completions',
      provider: 'test',
      baseUrl: '',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8_192,
  })),
}));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: vi.fn(() => async () => undefined),
}));

/**
 * The fake Agent the runner constructs. `prompt` stays pending until the test
 * releases it (or an abort fires), keeping the session "running" while
 * messages/cancels are injected through the wakeup. A steered message is
 * folded into the entry tree via message_end so the runner's post-settle
 * undelivered-message check counts it as delivered.
 */
const fake = vi.hoisted(() => {
  class FakeAgent {
    state: { messages: unknown[]; errorMessage?: string } = { messages: [] };
    steerCalls: Array<{ role: string; content: unknown }> = [];
    afterToolCall?: AgentOptions['afterToolCall'];
    /** What the runner built the agent with: its tools, among them the material tools. */
    options: { initialState?: { tools?: unknown[] } } = {};
    /** Hold a steered message's message_end until `consumeSteered` (pi consumes later). */
    deferSteerEnd = false;
    private heldSteers: Array<{ role: string; content: unknown }> = [];
    promptCalls = 0;
    abortCalls = 0;
    private subscribers = new Set<(event: unknown) => void>();
    private release: (() => void) | null = null;

    reset(): void {
      this.state = { messages: [] };
      this.steerCalls = [];
      this.heldSteers = [];
      this.deferSteerEnd = false;
      this.promptCalls = 0;
      this.abortCalls = 0;
      this.subscribers = new Set();
      this.release = null;
    }

    subscribe(cb: (event: unknown) => void): () => void {
      this.subscribers.add(cb);
      return () => this.subscribers.delete(cb);
    }

    abort(): void {
      this.abortCalls += 1;
      this.release?.();
    }

    /** Test hook: let the pending prompt resolve so the run can settle. */
    releasePrompt(): void {
      this.release?.();
      this.release = null;
    }

    clearAllQueues(): void {
      // buildAgent's terminal-barrier hook only calls this on a length stop,
      // which this harness never produces.
    }

    async prompt(input: unknown): Promise<void> {
      this.promptCalls += 1;
      // The prompt becomes the first user message of the conversation (real pi
      // behaviour) — folded into the entry tree via message_end so the
      // runner's post-settle undelivered-message check counts it as delivered.
      const message = Array.isArray(input)
        ? input[0]
        : input && typeof input === 'object'
          ? input
          : { role: 'user', content: input };
      this.state.messages.push(message);
      this.emitMessageEnd(message as { role: string; content: unknown });
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }

    async continue(): Promise<void> {
      await this.prompt('');
    }

    async followUp(message: { role: string; content: unknown }): Promise<void> {
      await this.prompt(String((message as { content?: unknown })?.content ?? ''));
    }

    async waitForIdle(): Promise<void> {
      // Idle immediately after prompt resolves; the drain loop then drains and
      // settles. A blocked prompt never reaches here.
    }

    steer(message: { role: string; content: unknown }): void {
      this.steerCalls.push(message);
      if (this.deferSteerEnd) {
        this.heldSteers.push(message);
        return;
      }
      this.state.messages.push(message);
      this.emitMessageEnd(message);
    }

    /** Test hook: pi takes the held steered messages into the conversation. */
    consumeSteered(): void {
      for (const message of this.heldSteers.splice(0)) {
        this.state.messages.push(message);
        this.emitMessageEnd(message);
      }
    }

    private emitMessageEnd(message: { role: string; content: unknown }): void {
      const event = { type: 'message_end', message };
      for (const cb of [...this.subscribers]) cb(event);
    }
  }

  const current: { instance?: FakeAgent } = {};
  return { FakeAgent, current };
});

vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>();
  class MockAgent extends fake.FakeAgent {
    constructor(
      options: {
        initialState?: { tools?: unknown[] };
        afterToolCall?: AgentOptions['afterToolCall'];
      } = {},
    ) {
      super();
      this.options = options;
      this.afterToolCall = options.afterToolCall;
      // The runner constructs exactly one Agent per run; expose it so tests can
      // wait for the run to reach the prompt and observe its steer/abort.
      fake.current.instance = this;
    }
  }
  return { ...actual, Agent: MockAgent };
});

const branching = vi.hoisted(() => ({
  applyBranchRequests: vi.fn(),
  recordCourseVersions: vi.fn(
    async (_deps: unknown, _input: { phase: string; status?: string }) =>
      [] as Array<{ stageId: string; versionId: string }>,
  ),
}));
vi.mock('@/lib/server/course-versions/branching', () => branching);
vi.mock('@/lib/server/course-versions/store', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/server/course-versions/store')>()),
  ensureCourseVersionStore: vi.fn(async () => undefined),
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: vi.fn(async () => ({
    pool: { query: async () => ({ rows: [] }) },
    withTransaction: vi.fn(),
  })),
}));

import { runSession } from '@/lib/server/agent-runtime/runner';

const SESSION = {
  id: 'session-wake',
  ownerId: 'owner-1',
  prompt: 'Build a lesson',
  stageId: 'stage-1',
  existingCourse: false,
  status: 'running' as const,
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
  claimReason: 'queued' as const,
  claimSeq: 1,
  deliveredUserMessageSeq: 0,
};

const userTurn = (text: string, seq?: number) => ({
  role: 'user',
  content: text,
  timestamp: 1,
  ...(seq ? { openmaicDurableUserMessageSeq: seq } : {}),
});
const finishedReply = (text: string) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  timestamp: 1,
});

function runEvents(): Array<{ type: string; data: Record<string, unknown> }> {
  return mocks.store.appendRunEvent.mock.calls
    .map((call) => (call as unknown[])[2] as { type: string; data: Record<string, unknown> })
    .filter(Boolean);
}

async function waitForPrompt(): Promise<void> {
  await vi.waitFor(() => expect(fake.current.instance?.promptCalls ?? 0).toBeGreaterThan(0));
}

function pendingRequests(requests: Array<{ seq: number; data: unknown }>) {
  mocks.history.events.push(
    ...requests.map(({ seq, data }) => ({
      id: seq,
      type: 'branch_request',
      ts: 1,
      attempt: 0,
      data,
    })),
  );
}

describe('runSession and branch requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.current.instance?.reset();
    fake.current.instance = undefined;
    mocks.history.events = [];
    mocks.entrySeed.length = 0;
    mocks.resetWorker();
    mocks.store.listUserMessages.mockResolvedValue([]);
    branching.recordCourseVersions.mockResolvedValue([]);
  });

  it('settles a switch-only claim without prompting, and reports the switch', async () => {
    mocks.entrySeed.push(userTurn('Build a lesson'), finishedReply('three pages'));
    pendingRequests([{ seq: 9, data: { op: 'switch', targetSeq: 0, variant: 'orig' } }]);
    branching.applyBranchRequests.mockResolvedValue({
      outcomes: [{ requestSeq: 9, op: 'switch', status: 'applied', checkedOut: [] }],
      regenerated: false,
    });

    await runSession({ running: new Map(), shuttingDown: false }, SESSION);

    expect(fake.current.instance).toBeUndefined();
    const end = runEvents().find((event) => event.type === 'session_end');
    expect(end?.data).toMatchObject({
      status: 'succeeded',
      note: 'branch requests only',
      branches: [{ requestSeq: 9, status: 'applied' }],
    });
    expect(runEvents()[0]?.type).toBe('session_end');
    expect(mocks.store.finishSession).toHaveBeenCalledWith(
      'session-wake',
      expect.any(String),
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('settles without prompting when the request was turned down, even mid-reply', async () => {
    // The branch the conversation stays on stopped before answering its last
    // message; a turned-down request must not resume it.
    mocks.entrySeed.push(
      userTurn('Build a lesson'),
      finishedReply('three pages'),
      userTurn('add a video', 3),
    );
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 3, ts: 1, text: 'add a video', delivery: 'queued', materials: [] },
    ]);
    pendingRequests([{ seq: 7, data: { op: 'regenerate', targetSeq: 3 } }]);
    branching.applyBranchRequests.mockResolvedValue({
      outcomes: [
        { requestSeq: 7, op: 'regenerate', status: 'rejected', reason: 'checkout_failed' },
      ],
      regenerated: false,
    });

    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, deliveredUserMessageSeq: 3 },
    );

    expect(fake.current.instance).toBeUndefined();
    expect(runEvents()).toHaveLength(1);
    expect(runEvents()[0]).toMatchObject({
      type: 'session_end',
      data: {
        status: 'succeeded',
        note: 'branch requests only',
        branches: [{ requestSeq: 7, status: 'rejected', reason: 'checkout_failed' }],
      },
    });
  });

  it('never sends a rejected edit, even when another message was posted after it', async () => {
    mocks.entrySeed.push(userTurn('Build a lesson'), finishedReply('Old course'));
    pendingRequests([{ seq: 7, data: { op: 'edit', targetSeq: 3 } }]);
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 8, ts: 1, text: 'Discard my whole course', delivery: 'queued', materials: [] },
      {
        seq: 9,
        ts: 1,
        text: 'Keep working on the original course',
        delivery: 'queued',
        materials: [],
      },
    ]);
    branching.applyBranchRequests.mockResolvedValue({
      outcomes: [{ requestSeq: 7, op: 'edit', status: 'rejected', reason: 'checkout_failed' }],
      regenerated: false,
    });
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, deliveredUserMessageSeq: 3 },
    );
    try {
      await waitForPrompt();
      expect(fake.current.instance!.state.messages).toContainEqual(
        expect.objectContaining({
          content: [{ type: 'text', text: 'Keep working on the original course' }],
        }),
      );
      expect(JSON.stringify(fake.current.instance!.state.messages)).not.toContain(
        'Discard my whole course',
      );
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
    }
  });

  it('delivers an accepted edit on this claim, before a later queued message', async () => {
    mocks.entrySeed.push(userTurn('Build a lesson'), finishedReply('Original baseline'));
    pendingRequests([{ seq: 7, data: { op: 'edit', targetSeq: 3 } }]);
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 8, ts: 1, text: 'New version', delivery: 'queued', materials: [] },
      { seq: 9, ts: 1, text: 'Another follow-up', delivery: 'queued', materials: [] },
    ]);
    branching.applyBranchRequests.mockResolvedValue({
      outcomes: [{ requestSeq: 7, op: 'edit', status: 'applied' }],
      regenerated: false,
    });
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, deliveredUserMessageSeq: 3 },
    );
    try {
      await waitForPrompt();
      expect(fake.current.instance!.state.messages[0]).toMatchObject({
        openmaicDurableUserMessageSeq: 8,
        content: [{ type: 'text', text: 'New version' }],
      });
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
    }
  });

  it('does not resume an interrupted reply when recovering after its switch-only receipt', async () => {
    mocks.entrySeed.push(userTurn('Interrupted question'));
    mocks.history.events.push({
      id: 5,
      ts: 1,
      attempt: 1,
      type: 'session_end',
      data: {
        status: 'succeeded',
        note: 'branch requests only',
        branches: [{ requestSeq: 2, status: 'applied' }],
      },
    });
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, claimReason: 'orphaned' },
    );
    await vi.waitFor(() =>
      expect(
        fake.current.instance?.promptCalls || mocks.store.finishSession.mock.calls.length,
      ).toBeGreaterThan(0),
    );
    fake.current.instance?.releasePrompt();
    await run;
    expect(fake.current.instance).toBeUndefined();
  });

  it('takes a before-turn snapshot when a follow-up is consumed by a running agent', async () => {
    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    try {
      await waitForPrompt();
      mocks.store.listUserMessages.mockResolvedValue([
        { seq: 7, ts: 1, text: 'Steered follow-up', delivery: 'steer', materials: [] },
      ]);
      mocks.bus.wake?.();
      await vi.waitFor(() => expect(fake.current.instance?.steerCalls).toHaveLength(1));
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
    }
    expect(branching.recordCourseVersions.mock.calls.map(([, input]) => input.phase)).toEqual([
      'before_run',
      'before_run',
      'after_run',
    ]);
  });

  it('records what a tool left behind when the agent throws during the run', async () => {
    const prompt = vi
      .spyOn(fake.FakeAgent.prototype, 'prompt')
      .mockRejectedValue(new Error('driver failed mid-run'));
    try {
      await runSession({ running: new Map(), shuttingDown: false }, SESSION);
      expect(branching.recordCourseVersions).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          phase: 'after_run',
          status: 'failed',
        }),
      );
    } finally {
      prompt.mockRestore();
    }
  });

  it('marks a failed before-turn capture so this message cannot silently reuse an older course', async () => {
    branching.recordCourseVersions.mockRejectedValueOnce(new Error('snapshot unavailable'));
    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    try {
      await waitForPrompt();
      expect(await mocks.tree?.getBranch()).toContainEqual(
        expect.objectContaining({
          customType: 'openmaic.course_versions',
          data: expect.objectContaining({ phase: 'before_run', unavailable: true }),
        }),
      );
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
    }
  });

  it('captures the course named by an element before the first edit to that course', async () => {
    mocks.entrySeed.push(userTurn('Opening'), finishedReply('Original course'));
    mocks.history.events.push({
      id: 3,
      type: 'user_message',
      ts: 1,
      attempt: 0,
      data: {
        text: 'Change the selected title',
        elementRefs: [
          {
            kind: 'slide-element',
            stageId: 'other-course',
            sceneId: 'p1',
            elementId: 't1',
            elementType: 'text',
            label: 'Title',
          },
        ],
      },
    });
    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    try {
      await waitForPrompt();
      const capture = branching.recordCourseVersions.mock.calls[0]?.[1] as {
        extraStageIds?: Iterable<string>;
      };
      expect(Array.from(capture.extraStageIds ?? [])).toContain('other-course');
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
    }
  });

  it('answers the message a regenerate moved onto, with the receipt on the first frame', async () => {
    // What the apply step leaves: the leaf on the user frame being answered again.
    mocks.entrySeed.push(
      userTurn('Build a lesson'),
      finishedReply('three pages'),
      userTurn('add a video', 3),
    );
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 3, ts: 1, text: 'add a video', delivery: 'queued', materials: [] },
    ]);
    pendingRequests([{ seq: 7, data: { op: 'regenerate', targetSeq: 3 } }]);
    branching.applyBranchRequests.mockResolvedValue({
      outcomes: [{ requestSeq: 7, op: 'regenerate', status: 'applied', checkedOut: [] }],
      regenerated: true,
    });

    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, deliveredUserMessageSeq: 3 },
    );
    try {
      await waitForPrompt();
      const first = runEvents()[0];
      expect(first?.type).toBe('session_resumed');
      expect(first?.data).toMatchObject({ branches: [{ requestSeq: 7, status: 'applied' }] });
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
    }
  });

  it('records course versions before a new user turn and after the run', async () => {
    const order: string[] = [];
    branching.recordCourseVersions.mockImplementation(
      async (_deps: unknown, input: { phase: string }) => {
        order.push(input.phase);
        return input.phase === 'after_run' ? [{ stageId: 'stage-1', versionId: 'cv-1' }] : [];
      },
    );

    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    try {
      await waitForPrompt();
      expect(order).toEqual(['before_run']);
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
    }
    expect(order).toEqual(['before_run', 'after_run']);
    expect(branching.recordCourseVersions).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ phase: 'after_run', status: 'succeeded' }),
    );
    const end = runEvents().find((event) => event.type === 'session_end');
    expect(end?.data).toMatchObject({
      courseVersions: [{ stageId: 'stage-1', versionId: 'cv-1' }],
    });
  });

  it('regenerates first even if a subsequent plain message is already queued', async () => {
    mocks.entrySeed.push(
      userTurn('Opening'),
      finishedReply('Course'),
      userTurn('Regenerate this', 3),
    );
    pendingRequests([{ seq: 7, data: { op: 'regenerate', targetSeq: 3 } }]);
    branching.applyBranchRequests.mockResolvedValue({
      outcomes: [{ requestSeq: 7, op: 'regenerate', status: 'applied' }],
      regenerated: true,
    });
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 3, ts: 1, text: 'Regenerate this', delivery: 'queued', materials: [] },
      { seq: 8, ts: 1, text: 'Next question', delivery: 'queued', materials: [] },
    ]);
    const next = vi.spyOn(fake.FakeAgent.prototype, 'continue');
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, deliveredUserMessageSeq: 3 },
    );
    try {
      await waitForPrompt();
      expect(next).toHaveBeenCalledOnce();
      expect(fake.current.instance!.state.messages[0]).not.toHaveProperty(
        'openmaicDurableUserMessageSeq',
        8,
      );
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
      next.mockRestore();
    }
  });

  it('prompts an accepted edit when a new worker recovers before its first user frame', async () => {
    mocks.entrySeed.push(
      userTurn('Opening'),
      finishedReply('Course'),
      userTurn('Steered question', 3),
    );
    pendingRequests([{ seq: 7, data: { op: 'edit', targetSeq: 4 } }]);
    mocks.history.events.push({
      id: 9,
      ts: 1,
      attempt: 1,
      type: 'session_resumed',
      data: {
        branches: [{ requestSeq: 7, op: 'edit', status: 'applied' }],
      },
    });
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 8, ts: 1, text: 'Edited instruction', delivery: 'queued', materials: [] },
    ]);
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, claimReason: 'orphaned', deliveredUserMessageSeq: 4 },
    );
    try {
      await waitForPrompt();
      expect(fake.current.instance!.state.messages[0]).toMatchObject({
        openmaicDurableUserMessageSeq: 8,
      });
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
    }
  });

  it('recovers an interrupted regeneration using the selected message, including its Skill', async () => {
    mocks.entrySeed.push(
      userTurn('Opening'),
      finishedReply('Course'),
      userTurn('Old instruction', 3),
      {
        customType: 'openmaic.reply_variant',
        data: { requestSeq: 12 },
      },
    );
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 3, ts: 1, text: 'Old instruction', delivery: 'queued', materials: [] },
      {
        seq: 9,
        ts: 1,
        text: '/other-skill from a different branch',
        delivery: 'queued',
        materials: [],
      },
    ]);
    const preload = vi.spyOn(
      await import('@/lib/server/agent-runtime/skill-preload'),
      'buildSkillPreload',
    );
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, claimReason: 'orphaned', deliveredUserMessageSeq: 9 },
    );
    try {
      await waitForPrompt();
      expect(preload).toHaveBeenCalledWith(expect.objectContaining({ text: 'Old instruction' }));
    } finally {
      fake.current.instance?.releasePrompt();
      await run;
      preload.mockRestore();
    }
  });

  it('does not deliver an edit twice after its user frame committed before the delivery cursor', async () => {
    mocks.entrySeed.push(
      userTurn('Opening'),
      finishedReply('Course'),
      userTurn('Edited instruction', 8),
    );
    pendingRequests([{ seq: 7, data: { op: 'edit', targetSeq: 4 } }]);
    mocks.history.events.push({
      id: 9,
      ts: 1,
      attempt: 1,
      type: 'session_resumed',
      data: {
        branches: [{ requestSeq: 7, op: 'edit', status: 'applied' }],
      },
    });
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 8, ts: 1, text: 'Edited instruction', delivery: 'queued', materials: [] },
    ]);
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, claimReason: 'orphaned', deliveredUserMessageSeq: 4 },
    );
    await waitForPrompt();
    fake.current.instance?.releasePrompt();
    await run;
    expect(fake.current.instance!.steerCalls).toEqual([]);
    expect(mocks.store.markUserMessageDelivered).toHaveBeenCalledWith(
      SESSION.id,
      expect.any(String),
      1,
      8,
    );
  });
});
