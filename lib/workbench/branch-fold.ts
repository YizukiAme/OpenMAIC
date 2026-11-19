/**
 * The conversation's branches, folded from the event log (#1317, prototype).
 *
 * The chat fold stays a flat, append-only list of nodes; this module tags every
 * node with the segment it belongs to and keeps the segments as a tree. A
 * segment is one user message (`user`) or one reply to it (`reply`). Editing a
 * message adds a sibling user segment, regenerating a reply adds a sibling
 * reply segment, and switching changes which child a segment shows. The
 * visible transcript is the nodes of the segments on the selected path
 * ({@link projectBranchChat}).
 *
 * Everything here reads only the event log -- `branch_request` events and the
 * order nodes appear in -- so a replayed log folds to exactly the branches a
 * live one did, and the UI stays a pure function of the events it has.
 */
import type { ChatNode, SessionStatus } from './session-store';

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
}

export type PendingBranch =
  | { op: 'edit'; parent: string }
  | { op: 'regenerate'; user: string; variant: number };

export interface BranchState {
  segments: Readonly<Record<string, BranchSegment>>;
  /** The segment new nodes go to. */
  current: string;
  /** A request whose new segment has not started yet. */
  pending: PendingBranch | null;
  /** Bumped by every request that changes the branch on screen. */
  epoch: number;
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
    pending: null,
    epoch: 0,
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
  let found: BranchSegment | undefined;
  for (const segment of Object.values(state.segments)) {
    if (segment.kind === 'user' && segment.userSeq === userSeq) found = segment;
  }
  return found;
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

/** Fold one `branch_request` event (`eventId` is its sequence). */
export function applyBranchRequest(state: BranchState, data: unknown, eventId: number): BranchState {
  const request = (data ?? {}) as { op?: unknown; targetSeq?: unknown; variant?: unknown };
  if (typeof request.targetSeq !== 'number') return state;
  const user = userSegmentOf(state, request.targetSeq);
  if (!user || user.parent === null) return state;
  switch (request.op) {
    case 'edit':
      return { ...state, pending: { op: 'edit', parent: user.parent }, epoch: state.epoch + 1 };
    case 'regenerate':
      return {
        ...state,
        current: user.id,
        pending: { op: 'regenerate', user: user.id, variant: eventId },
        epoch: state.epoch + 1,
      };
    case 'switch': {
      let next: BranchState;
      if (request.variant === undefined) {
        next = update(state, user.parent, (parent) => ({ ...parent, selected: user.id }));
      } else {
        const reply = user.children
          .map((id) => state.segments[id])
          .find((segment) => segment?.kind === 'reply' && segment.variant === request.variant);
        if (!reply) return state;
        next = update(state, user.id, (segment) => ({ ...segment, selected: reply.id }));
      }
      const path = activePath(next);
      return { ...next, current: path[path.length - 1]!.id, pending: null, epoch: state.epoch + 1 };
    }
    default:
      return state;
  }
}

function startSegment(
  state: BranchState,
  kind: 'user' | 'reply',
  extra: Pick<BranchSegment, 'userSeq' | 'variant'>,
): BranchState {
  let parent = state.current;
  let pending = state.pending;
  if (kind === 'user' && pending?.op === 'edit') {
    parent = pending.parent;
    pending = null;
  } else if (kind === 'reply' && pending?.op === 'regenerate') {
    parent = pending.user;
    pending = null;
  }
  const id = `s${Object.keys(state.segments).length}`;
  const segment: BranchSegment = { id, kind, parent, children: [], selected: null, ...extra };
  const withSegment: BranchState = {
    ...state,
    segments: { ...state.segments, [id]: segment },
    current: id,
    pending,
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
    if (node.segment) return node;
    const sameSlot = previous[index];
    let segment =
      sameSlot?.key === node.key ? sameSlot.segment : undefined;
    if (!segment) {
      byKey ??= new Map(previous.map((old) => [old.key, old.segment]));
      segment = byKey.get(node.key);
    }
    if (!segment) {
      if (node.kind === 'user') {
        branch = startSegment(branch, 'user', { userSeq: userSeqOfNodeKey(node.key) });
      } else if (
        branch.segments[branch.current]?.kind !== 'reply' ||
        branch.pending?.op === 'regenerate'
      ) {
        branch = startSegment(branch, 'reply', {
          variant: branch.pending?.op === 'regenerate' ? branch.pending.variant : 'orig',
        });
      }
      segment = branch.current;
    }
    changed = true;
    return { ...node, segment };
  });
  return { chat: changed ? chat : next, branch };
}

/** Record how a run ended on the reply it wrote into. A switch-only claim wrote nothing. */
export function markRunEnd(state: BranchState, data: unknown): BranchState {
  const end = (data ?? {}) as { status?: unknown; note?: unknown };
  if (end.note === 'branch switched') return state;
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

export function projectBranchChat(chat: readonly ChatNode[], state: BranchState): BranchView {
  const path = activePath(state);
  const onPath = new Set(path.map((segment) => segment.id));
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
  const visible = chat.filter((node) => !node.segment || onPath.has(node.segment));
  return { chat: visible, forks, segments: state.segments };
}
