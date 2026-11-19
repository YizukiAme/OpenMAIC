/** Conversation segments reconstructed from durable events. Each segment is one
 * user message or one of its replies. A checkout stores the outgoing rows and
 * puts the selected path back in the ordinary workbench fold, shared by the
 * transcript, the question form and the course preview. */
import type { ChatNode, SessionStatus, WorkbenchEvent, WorkbenchFold } from './session-store';

type CourseProgress = Pick<WorkbenchFold, 'plan' | 'pages' | 'courseTitle'>;
export const ROOT_SEGMENT = 'root';

export interface BranchSegment {
  id: string;
  kind: 'root' | 'user' | 'reply';
  parent: string | null;
  children: string[];
  /** The child this segment shows; the newest one unless a switch said otherwise. */
  selected: string | null;
  /** User segments: the durable `user_message` sequence; 0 is the opening prompt. */
  userSeq?: number;
  /** Reply segments: `'orig'`, or the `regenerate` request that produced it. */
  variant?: number | 'orig';
  /** Reply segments: how the last run that wrote into it ended. */
  endStatus?: SessionStatus;
  progress?: CourseProgress;
}

export interface BranchReceipt {
  requestSeq: number;
  op: string;
  status: 'applied' | 'rejected';
  reason?: string;
  rollbackFailed?: boolean;
  checkedOut?: { stageId: string; outcome: string }[];
}

export function branchReceipts(data: unknown): BranchReceipt[] {
  const branches = (data as { branches?: unknown } | null)?.branches;
  return Array.isArray(branches)
    ? branches.filter(
        (r) =>
          Number.isSafeInteger(r?.requestSeq) &&
          (r.status === 'applied' || r.status === 'rejected'),
      )
    : [];
}

export interface BranchState {
  segments: Readonly<Record<string, BranchSegment>>;
  current: string;
  /** Rows of branches already visited, saved only when moving away. */
  saved: Readonly<Record<string, ChatNode[]>>;
  /** Branch requests and user messages received before the worker finishes checkout. */
  inbox: readonly WorkbenchEvent[];
  lastReceipt?: BranchReceipt;
}

export function initialBranchState(): BranchState {
  return {
    segments: {
      [ROOT_SEGMENT]: {
        id: ROOT_SEGMENT,
        kind: 'root',
        parent: null,
        children: [],
        selected: null,
      },
    },
    current: ROOT_SEGMENT,
    saved: {},
    inbox: [],
  };
}

function update(
  state: BranchState,
  id: string,
  patch: (segment: BranchSegment) => BranchSegment,
): BranchState {
  const segment = state.segments[id];
  if (!segment) return state;
  return { ...state, segments: { ...state.segments, [id]: patch(segment) } };
}

/** The user segment of a durable message sequence (the newest, if replayed twice). */
export function userSegmentOf(state: BranchState, userSeq: number): BranchSegment | undefined {
  const segments = Object.values(state.segments);
  if (userSeq === 0) return segments.find((segment) => segment.kind === 'user');
  return segments.findLast((segment) => segment.kind === 'user' && segment.userSeq === userSeq);
}

/** The segments on screen, root first. */
export function activePath(state: BranchState): BranchSegment[] {
  const path: BranchSegment[] = [];
  let segment: BranchSegment | undefined = state.segments[ROOT_SEGMENT];
  while (segment) {
    path.push(segment);
    segment = segment.selected ? state.segments[segment.selected] : undefined;
  }
  return path;
}

/** Apply a confirmed request, saving the current path before selecting the target. */
export function checkoutBranch(fold: WorkbenchFold, request: WorkbenchEvent): WorkbenchFold {
  const state = fold.branch!;
  const { op, targetSeq, variant } = request.data as {
    op: string;
    targetSeq: number;
    variant?: number | 'orig';
  };
  const user = userSegmentOf(state, targetSeq);
  if (!user?.parent) return fold;
  let target: string;
  if (op === 'regenerate') target = user.id;
  else if (op === 'edit') target = user.parent;
  else if (variant === undefined) target = user.id;
  else {
    const reply = user.children
      .map((id) => state.segments[id])
      .find((child) => child?.variant === variant);
    if (!reply) return fold;
    target = reply.id;
  }

  const saved = { ...state.saved };
  for (const segment of activePath(state)) saved[segment.id] = [];
  for (const node of fold.chat) saved[node.segment ?? ROOT_SEGMENT]!.push(node);

  let branch: BranchState = { ...state, saved, current: target };
  let child = branch.segments[target]!;
  while (child.parent) {
    const id = child.id;
    branch = update(branch, child.parent, (parent) => ({ ...parent, selected: id }));
    child = branch.segments[child.parent]!;
  }
  if (op === 'regenerate') branch = startSegment(branch, 'reply', { variant: request.id });
  else if (op === 'edit')
    branch = update(branch, target, (parent) => ({ ...parent, selected: null }));
  const path = activePath(branch);
  const progress = path.findLast((segment) => segment.progress)?.progress;
  return {
    ...fold,
    plan: progress?.plan ?? [],
    pages: progress?.pages ?? {},
    courseTitle: progress?.courseTitle ?? null,
    chat: path.flatMap((segment) => saved[segment.id] ?? []),
    branch: { ...branch, current: path.at(-1)!.id },
    runCourseStageIds: [],
    thinkingKey: null,
    assistantKey: null,
    waitingKey: null,
    waitingArmed: false,
    generatingOrder: null,
    generationOpen: false,
    error: null,
  };
}

export function recordBranchProgress(
  state: BranchState,
  { plan, pages, courseTitle }: CourseProgress,
): BranchState {
  return update(state, state.current, (segment) => ({
    ...segment,
    progress: { plan, pages, courseTitle },
  }));
}

function startSegment(
  state: BranchState,
  kind: 'user' | 'reply',
  extra: Pick<BranchSegment, 'userSeq' | 'variant'>,
): BranchState {
  const parent = state.current;
  const id = `s${Object.keys(state.segments).length}`;
  const segment: BranchSegment = { id, kind, parent, children: [], selected: null, ...extra };
  const withSegment: BranchState = {
    ...state,
    segments: { ...state.segments, [id]: segment },
    current: id,
  };
  return update(withSegment, parent, (owner) => ({
    ...owner,
    children: [...owner.children, id],
    selected: id,
  }));
}

/** `e123` is the durable message 123; `e45-u` is the opening prompt `session_start` paints. */
export function userSeqOfNodeKey(key: string): number | undefined {
  const durable = /^e(\d+)$/.exec(key);
  if (durable) return Number(durable[1]);
  return /^e\d+-u$/.test(key) ? 0 : undefined;
}

/**
 * Tag the nodes a fold step added with their segment, starting segments as
 * needed: a user node starts a user segment; anything else starts a reply
 * segment unless one is already open.
 *
 */
export function assignSegments(
  previous: readonly ChatNode[],
  next: ChatNode[],
  state: BranchState,
): { chat: ChatNode[]; branch: BranchState } {
  if (next === previous) return { chat: next, branch: state };
  let branch = state;
  let byKey: Map<string, string | undefined> | undefined;
  let changed = false;
  const chat = next.map((node, index) => {
    if (node.segment && branch.segments[node.segment]) return node;
    const sameSlot = previous[index];
    let segment = sameSlot?.key === node.key ? sameSlot.segment : undefined;
    if (!segment) {
      byKey ??= new Map(previous.map((old) => [old.key, old.segment]));
      segment = byKey.get(node.key);
    }
    if (segment && !branch.segments[segment]) segment = undefined;
    if (!segment) {
      if (node.kind === 'user') {
        branch = startSegment(branch, 'user', { userSeq: userSeqOfNodeKey(node.key) });
      } else if (branch.segments[branch.current]?.kind !== 'reply') {
        branch = startSegment(branch, 'reply', { variant: 'orig' });
      }
      segment = branch.current;
    }
    changed = true;
    return { ...node, segment };
  });
  return { chat: changed ? chat : next, branch };
}

/** Record how a run ended on the reply it wrote into. A claim made only for branch requests wrote nothing. */
export function markRunEnd(state: BranchState, data: unknown): BranchState {
  const end = (data ?? {}) as { status?: unknown; note?: unknown };
  if (end.note === 'branch requests only') return state;
  const current = state.segments[state.current];
  if (current?.kind !== 'reply' || typeof end.status !== 'string') return state;
  return update(state, current.id, (segment) => ({
    ...segment,
    endStatus: end.status as SessionStatus,
  }));
}

/** A fork on screen: which of its siblings this segment is. */
export interface BranchFork {
  segment: BranchSegment;
  index: number;
  count: number;
  siblings: BranchSegment[];
}

export interface BranchView {
  /** The nodes of the segments on screen, in log order. */
  chat: ChatNode[];
  /** Per segment on screen (by id): its fork, when it has siblings. */
  forks: ReadonlyMap<string, BranchFork>;
  segments: Readonly<Record<string, BranchSegment>>;
}

export function projectBranchChat(chat: ChatNode[], state: BranchState): BranchView {
  const path = activePath(state);
  const forks = new Map<string, BranchFork>();
  for (const segment of path) {
    if (!segment.parent) continue;
    const parent = state.segments[segment.parent];
    if (!parent) continue;
    const siblings = parent.children
      .map((id) => state.segments[id]!)
      .filter((sibling) => sibling && sibling.kind === segment.kind);
    if (siblings.length > 1) {
      forks.set(segment.id, {
        segment,
        index: siblings.findIndex((sibling) => sibling.id === segment.id),
        count: siblings.length,
        siblings,
      });
    }
  }
  return { chat, forks, segments: state.segments };
}
