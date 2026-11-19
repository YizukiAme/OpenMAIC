/**
 * The runner's side of edit-and-resend (#1317, prototype): recording which
 * course versions a branch is on, and applying branch requests.
 *
 * A branch request is a durable `branch_request` event the branch route
 * appends (`app/api/agent/sessions/[id]/branch`). The route then requeues the
 * session, so the runner -- the only writer of the entry tree -- applies it
 * under its lease, before it plans the run:
 *
 * 1. The live course is recorded on the branch being left, so hand edits made
 *    there since its last version stay on that branch.
 * 2. Every course the target branch names a version of is written back to
 *    that version.
 * 3. Only then does the leaf move (`planBranchMove`).
 *
 * A request lands whole or not at all: if a course cannot be written back, the
 * ones already written are put back, the leaf stays, and the request is
 * rejected, so a run never answers on a branch whose courses did not land.
 *
 * The outcome of each request is reported on the run's first lifecycle frame
 * (`branches` on `session_start`, `session_resumed` or `session_end`): a run's
 * first durable event must be a lifecycle frame, and that frame is also what
 * marks the request as processed, so a later claim never applies it twice. A
 * claim that dies before that frame applies the request again, which is safe:
 * see {@link applyBranchRequests}.
 */
import type { Session } from '@earendil-works/pi-agent-core';
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  checkoutCourseVersion,
  snapshotCourse,
  type CheckoutOutcome,
  type CourseDocumentWriter,
  type CourseVersionDatabase,
} from './store';
import {
  COURSE_VERSIONS_ENTRY,
  REPLY_VARIANT_ENTRY,
  beforeSwitchEntryOf,
  courseVersionsOnPath,
  parseBranchRequest,
  planBranchMove,
  type BranchOp,
  type BranchRejectReason,
  type CourseVersionsEntryData,
  type TreeEntry,
} from './tree';

export const BRANCH_REQUEST_EVENT = 'branch_request';

/** Lifecycle frames that can carry `branches`, the processed-request receipt. */
const RECEIPT_FRAME_TYPES = ['session_start', 'session_resumed', 'session_end'];

export interface PendingBranchRequest {
  seq: number;
  data: unknown;
}

export interface BranchOutcome {
  requestSeq: number;
  op: BranchOp | 'unknown';
  status: 'applied' | 'rejected';
  /**
   * Rejected only. `checkout_failed`: a course could not be written back to
   * the target branch's version. `apply_failed`: another step failed (taking
   * a version, moving the leaf). Either way the request was undone.
   */
  reason?: BranchRejectReason | 'media_pending' | 'checkout_failed' | 'apply_failed';
  /**
   * With `checkout_failed` or `apply_failed`: undoing failed too, so a course
   * may be left at the other branch's version.
   */
  rollbackFailed?: true;
  checkedOut?: Array<{ stageId: string; versionId: string; outcome: CheckoutOutcome }>;
}

/**
 * Branch requests no lifecycle frame has reported yet, oldest first.
 *
 * Reads the session's own event rows directly: the event log has no typed
 * query for one event type, and the requests are few.
 */
export async function readPendingBranchRequests(
  queryable: Queryable,
  sessionId: string,
): Promise<PendingBranchRequest[]> {
  const result = await queryable.query<{ seq: number; type: string; data: unknown }>(
    `SELECT seq, type, data FROM agent_session_events
      WHERE session_id = $1 AND type = ANY($2::text[])
      ORDER BY seq`,
    [sessionId, [BRANCH_REQUEST_EVENT, ...RECEIPT_FRAME_TYPES]],
  );
  const processed = new Set<number>();
  const requests: PendingBranchRequest[] = [];
  for (const row of result.rows) {
    if (row.type === BRANCH_REQUEST_EVENT) {
      requests.push({ seq: Number(row.seq), data: row.data });
      continue;
    }
    const branches = (row.data as { branches?: unknown } | null)?.branches;
    if (!Array.isArray(branches)) continue;
    for (const outcome of branches) {
      const seq = (outcome as { requestSeq?: unknown })?.requestSeq;
      if (Number.isSafeInteger(seq)) processed.add(Number(seq));
    }
  }
  return requests.filter((request) => !processed.has(request.seq));
}

export interface CourseVersionDeps {
  sessionId: string;
  ownerId: string;
  /** The session's own course; recorded whenever it exists. */
  defaultStageId: string;
  /** The pi session over the run's leased entry tree. */
  session: Session;
  /** A required, lease-fenced tree write. */
  writeEntry: (write: () => Promise<void>) => Promise<void>;
  documents: CourseDocumentWriter;
  db: CourseVersionDatabase;
}

/**
 * Record the courses as they are now on the current branch.
 *
 * Covers every course the branch already names a version of, the session's
 * own course, and `extraStageIds` (the courses a run just wrote). Appends an
 * entry only when some course is not already at the version its path names,
 * so an unchanged course costs a read and a hash, and no tree write.
 */
export async function recordCourseVersions(
  deps: CourseVersionDeps,
  input: {
    phase: CourseVersionsEntryData['phase'];
    status?: string;
    extraStageIds?: Iterable<string>;
    /** A branch request's before-switch record: written even when nothing changed. */
    requestSeq?: number;
  },
): Promise<CourseVersionsEntryData['versions']> {
  const onPath = courseVersionsOnPath((await deps.session.getBranch()) as unknown as TreeEntry[]);
  const stageIds = new Set<string>([
    ...onPath.keys(),
    deps.defaultStageId,
    ...(input.extraStageIds ?? []),
  ]);
  const versions: CourseVersionsEntryData['versions'] = [];
  let changed = false;
  for (const stageId of stageIds) {
    if (!stageId) continue;
    const record = await snapshotCourse(deps.db, {
      ownerId: deps.ownerId,
      stageId,
      sessionId: deps.sessionId,
      origin: input.phase,
      documents: deps.documents,
    });
    if (!record) continue;
    versions.push({ stageId, versionId: record.id });
    if (onPath.get(stageId) !== record.id) changed = true;
  }
  if (changed || input.requestSeq !== undefined) {
    const data: CourseVersionsEntryData = {
      phase: input.phase,
      versions,
      ...(input.status ? { status: input.status } : {}),
      ...(input.requestSeq !== undefined ? { requestSeq: input.requestSeq } : {}),
    };
    await deps.writeEntry(async () => {
      await deps.session.appendCustomEntry(COURSE_VERSIONS_ENTRY, data);
    });
  }
  return versions;
}

export interface ApplyBranchResult {
  outcomes: BranchOutcome[];
  /**
   * A regenerate moved the leaf onto a user frame, so the claim has a message
   * to answer again. Otherwise only a user message waiting for delivery gives
   * a claim made for branch requests a run to make.
   */
  regenerated: boolean;
}

type ApplyDeps = CourseVersionDeps & { hasPendingMedia: () => boolean };

async function treeEntries(deps: CourseVersionDeps): Promise<TreeEntry[]> {
  return (await deps.session.getEntries()) as unknown as TreeEntry[];
}

async function pathTo(deps: CourseVersionDeps, leafId: string | null): Promise<TreeEntry[]> {
  if (leafId === null) return [];
  return (await deps.session.getBranch(leafId)) as unknown as TreeEntry[];
}

/**
 * Apply pending branch requests in order.
 *
 * Each request lands whole or changes nothing (#1317: a partial failure must
 * move neither the conversation nor the course). The courses are written back
 * before the leaf moves; if a course cannot be, or a later step fails, every
 * course the request touched is written back to where the request found it,
 * the leaf stays (or goes back) where it was, and the request is rejected.
 *
 * Applying a request again after a claim died part-way is safe. The
 * before-switch entry is written first and names the request, so a second
 * pass knows the request had started: it does not record the live course
 * again (it may already be half written back) and reads the starting point
 * from that entry. A regenerate reuses the reply marker it wrote.
 *
 * Never throws for a request's own failure; a lost lease surfaces when the
 * runner checks it right after, and the request is applied again later.
 */
export async function applyBranchRequests(
  deps: ApplyDeps,
  requests: readonly PendingBranchRequest[],
): Promise<ApplyBranchResult> {
  const outcomes: BranchOutcome[] = [];
  let regenerated = false;
  for (const request of requests) {
    const outcome = await applyBranchRequest(deps, request);
    if (outcome.status === 'applied' && outcome.op === 'regenerate') regenerated = true;
    outcomes.push(outcome);
  }
  return { outcomes, regenerated };
}

async function applyBranchRequest(
  deps: ApplyDeps,
  request: PendingBranchRequest,
): Promise<BranchOutcome> {
  const requestSeq = request.seq;
  const parsed = parseBranchRequest(request.data);
  if (!parsed) {
    return { requestSeq, op: 'unknown', status: 'rejected', reason: 'invalid_request' };
  }
  const op = parsed.op;
  // A detached media job patches the live document when it finishes. If the
  // course moved to another branch meanwhile, that patch would land on the
  // wrong branch's course, so a branch change waits for it.
  if (deps.hasPendingMedia()) {
    return { requestSeq, op, status: 'rejected', reason: 'media_pending' };
  }
  const planned = planBranchMove(await treeEntries(deps), parsed, requestSeq);
  if (planned.kind === 'reject') {
    return { requestSeq, op, status: 'rejected', reason: planned.reason };
  }

  // Where the request found the conversation, once known; and the courses it
  // has written back so far. Both are what undoing it needs.
  let start: { leafId: string | null; versions: Map<string, string> } | undefined;
  const touched = new Map<string, string | null>();
  try {
    // 1. Keep what the branch being left looks like now. Written once per
    // request; on a second pass it is how the request knows it had started.
    if (!beforeSwitchEntryOf(await treeEntries(deps), requestSeq)) {
      await recordCourseVersions(deps, { phase: 'before_switch', requestSeq });
    }
    const entries = await treeEntries(deps);
    const startLeaf =
      beforeSwitchEntryOf(entries, requestSeq)?.id ?? (await deps.session.getLeafId());
    start = { leafId: startLeaf, versions: courseVersionsOnPath(await pathTo(deps, startLeaf)) };
    // Planned again over the entries as they are now: the target is the same
    // message or reply, but the end of a branch can have moved.
    const move = planBranchMove(entries, parsed, requestSeq);
    if (move.kind === 'reject') return { requestSeq, op, status: 'rejected', reason: move.reason };

    // 2. Write every course the target branch names back to its version there.
    const target = courseVersionsOnPath(await pathTo(deps, move.leafId));
    const checkedOut: NonNullable<BranchOutcome['checkedOut']> = [];
    for (const [stageId, versionId] of target) {
      // A course the starting branch names no version of: keep how it is now,
      // so undoing can put it back.
      if (!start.versions.has(stageId)) {
        const before = await snapshotCourse(deps.db, {
          ownerId: deps.ownerId,
          stageId,
          sessionId: deps.sessionId,
          origin: 'before_switch',
          documents: deps.documents,
        });
        touched.set(stageId, before?.id ?? null);
      } else {
        touched.set(stageId, start.versions.get(stageId)!);
      }
      try {
        const outcome = await checkoutCourseVersion(deps.db, {
          versionId,
          stageId,
          documents: deps.documents,
        });
        checkedOut.push({ stageId, versionId, outcome });
      } catch {
        return await undo(deps, { requestSeq, op, reason: 'checkout_failed' }, start, touched);
      }
    }

    // 3. Move, now that the courses are there.
    await deps.writeEntry(async () => {
      await deps.session.moveTo(move.leafId);
    });
    if (move.replyVariant) {
      const marker = move.replyVariant;
      await deps.writeEntry(async () => {
        await deps.session.appendCustomEntry(REPLY_VARIANT_ENTRY, marker);
      });
    }
    return { requestSeq, op, status: 'applied', checkedOut };
  } catch {
    if (!start) return { requestSeq, op, status: 'rejected', reason: 'apply_failed' };
    return await undo(deps, { requestSeq, op, reason: 'apply_failed' }, start, touched);
  }
}

/**
 * Put a request that failed part-way back where it found things: every course
 * it touched to its starting version, and the leaf to its starting point.
 */
async function undo(
  deps: ApplyDeps,
  outcome: Pick<BranchOutcome, 'requestSeq' | 'op'> & {
    reason: 'checkout_failed' | 'apply_failed';
  },
  start: { leafId: string | null; versions: Map<string, string> },
  touched: ReadonlyMap<string, string | null>,
): Promise<BranchOutcome> {
  let complete = true;
  for (const [stageId, versionId] of touched) {
    // The course did not exist when the request started, and checking a
    // version out never brings a course back, so there is nothing to undo.
    if (versionId === null) continue;
    try {
      await checkoutCourseVersion(deps.db, { versionId, stageId, documents: deps.documents });
    } catch {
      complete = false;
    }
  }
  try {
    if ((await deps.session.getLeafId()) !== start.leafId) {
      await deps.writeEntry(async () => {
        await deps.session.moveTo(start.leafId);
      });
    }
  } catch {
    complete = false;
  }
  return { ...outcome, status: 'rejected', ...(complete ? {} : { rollbackFailed: true }) };
}
