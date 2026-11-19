/**
 * How a conversation branch names the course versions it is on, and how a
 * branch request picks the point of the tree it moves to (#1317, prototype).
 *
 * The runner appends `custom` entries to the session's entry tree. Custom
 * entries never reach the model: the context is built from messages, custom
 * messages and branch summaries only. Two kinds are used here:
 *
 * - {@link COURSE_VERSIONS_ENTRY}, before and after every run (and before the
 *   conversation leaves a branch), naming the version each course was at.
 *   The version a branch is on, per course, is the nearest such entry on the
 *   path from its leaf to the root. Moving the leaf is therefore all it takes
 *   to put the conversation on another branch's courses; no table maps
 *   branches to versions.
 * - {@link REPLY_VARIANT_ENTRY}, right under a user message whose reply is
 *   being generated again, naming the request that asked for it. It is how a
 *   later switch finds that reply among its siblings.
 *
 * Everything here is pure over the entry list, so it is tested without a
 * database.
 */

export const COURSE_VERSIONS_ENTRY = 'openmaic.course_versions';
export const REPLY_VARIANT_ENTRY = 'openmaic.reply_variant';

/** The runner's tag on a user frame: the durable `user_message` it delivers. */
const DURABLE_USER_MESSAGE_SEQ = 'openmaicDurableUserMessageSeq';

/** The minimal shape of an entry-tree row this module reads. */
export interface TreeEntry {
  id: string;
  parentId: string | null;
  type: string;
  [key: string]: unknown;
}

export interface CourseVersionsEntryData {
  phase: 'before_run' | 'after_run' | 'before_switch';
  versions: Array<{ stageId: string; versionId: string }>;
  /** After-run entries only: how the run ended. */
  status?: string;
  /**
   * Before-switch entries a branch request writes: the request's event
   * sequence. The request writes this entry even when no course changed, so a
   * claim that applies the request again after dying part-way can tell it had
   * already started.
   */
  requestSeq?: number;
}

export interface ReplyVariantEntryData {
  /** The `branch_request` event that asked for this reply. */
  requestSeq: number;
}

function customOf(entry: TreeEntry, customType: string): unknown {
  return entry.type === 'custom' && entry.customType === customType ? entry.data : undefined;
}

/** The before-switch entry a branch request wrote, if it got that far. */
export function beforeSwitchEntryOf(
  entries: readonly TreeEntry[],
  requestSeq: number,
): TreeEntry | undefined {
  return entries.find((entry) => {
    const data = customOf(entry, COURSE_VERSIONS_ENTRY) as CourseVersionsEntryData | undefined;
    return data?.phase === 'before_switch' && data.requestSeq === requestSeq;
  });
}

/**
 * Whether an entry is a node of the conversation. Leaf entries only move the
 * cursor and labels only name a node; both carry a `parentId` but are not
 * part of any branch.
 */
export function isConversationNode(entry: TreeEntry): boolean {
  return entry.type !== 'leaf' && entry.type !== 'label';
}

/** Per course, the version the path's leaf is on (the nearest entry wins). */
export function courseVersionsOnPath(path: readonly TreeEntry[]): Map<string, string> {
  const versions = new Map<string, string>();
  for (const entry of path) {
    const data = customOf(entry, COURSE_VERSIONS_ENTRY) as CourseVersionsEntryData | undefined;
    if (!data || !Array.isArray(data.versions)) continue;
    for (const version of data.versions) {
      if (typeof version?.stageId === 'string' && typeof version.versionId === 'string') {
        versions.set(version.stageId, version.versionId);
      }
    }
  }
  return versions;
}

/** The durable `user_message` sequence a user frame was delivered from, if tagged. */
export function userMessageSeqOf(entry: TreeEntry): number | null | undefined {
  if (entry.type !== 'message') return undefined;
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || message.role !== 'user') return undefined;
  const value = message[DURABLE_USER_MESSAGE_SEQ];
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

/**
 * The user frame a request names.
 *
 * `seq > 0` is a durable `user_message` event sequence; the newest frame
 * carrying it wins (a crash-replayed delivery can append a second one). `0`
 * names the opening prompt, the first user frame of the tree, which a session
 * created without opening context does not tag.
 */
export function findUserEntry(entries: readonly TreeEntry[], seq: number): TreeEntry | undefined {
  if (seq === 0) {
    return entries.find((entry) => userMessageSeqOf(entry) !== undefined);
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (userMessageSeqOf(entries[index]!) === seq) return entries[index];
  }
  return undefined;
}

/** Conversation-node children of every node, in append order. */
export function childrenOf(entries: readonly TreeEntry[]): Map<string | null, TreeEntry[]> {
  const children = new Map<string | null, TreeEntry[]>();
  for (const entry of entries) {
    if (!isConversationNode(entry)) continue;
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  return children;
}

/**
 * The most recently written end of the subtree under `rootId`: where a branch
 * continues when the conversation switches back to it.
 */
export function latestLeafUnder(entries: readonly TreeEntry[], rootId: string): string {
  const children = childrenOf(entries);
  const order = new Map(entries.map((entry, index) => [entry.id, index]));
  let best = rootId;
  let bestOrder = -1;
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const below = children.get(id) ?? [];
    if (below.length === 0) {
      const at = order.get(id) ?? -1;
      if (at > bestOrder) {
        best = id;
        bestOrder = at;
      }
      continue;
    }
    for (const child of below) stack.push(child.id);
  }
  return best;
}

/**
 * One reply to a user frame: `'orig'` is the reply written when the message was
 * first delivered, a number the reply a `regenerate` request with that event
 * sequence produced.
 */
export function replyVariantChild(
  entries: readonly TreeEntry[],
  userEntryId: string,
  variant: number | 'orig',
): TreeEntry | undefined {
  const below = childrenOf(entries).get(userEntryId) ?? [];
  if (variant === 'orig') {
    return below.find((entry) => customOf(entry, REPLY_VARIANT_ENTRY) === undefined);
  }
  for (let index = below.length - 1; index >= 0; index -= 1) {
    const data = customOf(below[index]!, REPLY_VARIANT_ENTRY) as ReplyVariantEntryData | undefined;
    if (data?.requestSeq === variant) return below[index];
  }
  return undefined;
}

export type BranchOp = 'regenerate' | 'edit' | 'switch';

export interface BranchRequestData {
  op: BranchOp;
  /** The durable `user_message` sequence the request is about; 0 is the opening prompt. */
  targetSeq: number;
  /** Switch only: which reply of that message. Absent selects the message itself. */
  variant?: number | 'orig';
}

export type BranchMove =
  | { kind: 'move'; leafId: string | null; replyVariant?: ReplyVariantEntryData }
  | { kind: 'reject'; reason: BranchRejectReason };

export type BranchRejectReason =
  | 'invalid_request'
  | 'target_not_found'
  | 'variant_not_found'
  | 'opening_message_not_editable';

export function parseBranchRequest(data: unknown): BranchRequestData | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const op = record.op;
  if (op !== 'regenerate' && op !== 'edit' && op !== 'switch') return null;
  const targetSeq = record.targetSeq;
  if (!Number.isSafeInteger(targetSeq) || (targetSeq as number) < 0) return null;
  const variant = record.variant;
  if (
    variant !== undefined &&
    variant !== 'orig' &&
    !(Number.isSafeInteger(variant) && (variant as number) > 0)
  ) {
    return null;
  }
  return {
    op,
    targetSeq: targetSeq as number,
    ...(variant !== undefined ? { variant: variant as number | 'orig' } : {}),
  };
}

/**
 * Where a branch request moves the conversation.
 *
 * - `regenerate`: to the user frame itself, with a reply-variant marker under
 *   it, so the next run answers that message again on a new branch.
 * - `edit`: to the user frame's parent, so the edited message, delivered next,
 *   becomes its sibling. The parent is the course versions taken just before
 *   that message's run, so the edited message starts from the same course.
 * - `switch`: to the latest end of the chosen message or reply.
 */
export function planBranchMove(
  entries: readonly TreeEntry[],
  request: BranchRequestData,
  requestSeq: number,
): BranchMove {
  const user = findUserEntry(entries, request.targetSeq);
  if (!user) return { kind: 'reject', reason: 'target_not_found' };
  switch (request.op) {
    case 'regenerate': {
      // Applied again after a claim died part-way: answer under the marker the
      // request already wrote rather than leaving an empty one behind.
      const written = replyVariantChild(entries, user.id, requestSeq);
      if (written) return { kind: 'move', leafId: latestLeafUnder(entries, written.id) };
      return { kind: 'move', leafId: user.id, replyVariant: { requestSeq } };
    }
    case 'edit':
      // Moving to the root would make the next run a fresh start, which reads
      // the session's own prompt rather than the edited message.
      if (user.parentId === null) return { kind: 'reject', reason: 'opening_message_not_editable' };
      return { kind: 'move', leafId: user.parentId };
    case 'switch': {
      if (request.variant === undefined) {
        return { kind: 'move', leafId: latestLeafUnder(entries, user.id) };
      }
      const reply = replyVariantChild(entries, user.id, request.variant);
      if (!reply) return { kind: 'reject', reason: 'variant_not_found' };
      return { kind: 'move', leafId: latestLeafUnder(entries, reply.id) };
    }
    default:
      return { kind: 'reject', reason: 'invalid_request' };
  }
}
