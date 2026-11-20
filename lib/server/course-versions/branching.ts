/** Course snapshots and branch changes on the session's existing entry tree. */
import type { Session } from '@earendil-works/pi-agent-core';
import {
  checkoutCourseVersion,
  lockCourseVersionStages,
  snapshotCourse,
  type CheckoutOutcome,
  type CourseVersionDatabase,
} from './store';
import {
  COURSE_VERSIONS_ENTRY,
  REPLY_VARIANT_ENTRY,
  beforeSwitchEntryOf,
  courseVersionsOnPath,
  findUserEntry,
  lastVersionBoundary,
  parseBranchRequest,
  planBranchMove,
  type BranchOp,
  type BranchRejectReason,
  type CourseVersionsEntryData,
  type TreeEntry,
} from './tree';

type Checkout = { stageId: string; versionId: string; outcome: CheckoutOutcome };
export interface BranchOutcome {
  requestSeq: number;
  op: BranchOp | 'unknown';
  status: 'applied' | 'rejected';
  reason?: BranchRejectReason | 'media_pending' | 'checkout_failed' | 'apply_failed';
  checkedOut?: Checkout[];
}

export interface CourseVersionDeps {
  sessionId: string;
  ownerId: string;
  defaultStageId: string;
  session: Session;
  writeEntry: (write: () => Promise<void>) => Promise<void>;
  db: CourseVersionDatabase;
}

async function snapshotStages(
  deps: CourseVersionDeps,
  stageIds: Iterable<string>,
  phase: CourseVersionsEntryData['phase'],
) {
  const versions: CourseVersionsEntryData['versions'] = [];
  for (const stageId of [...new Set(stageIds)].filter(Boolean).sort()) {
    const record = await snapshotCourse(deps.db, {
      ownerId: deps.ownerId,
      stageId,
      sessionId: deps.sessionId,
      origin: phase,
    });
    if (record) versions.push({ stageId, versionId: record.id });
  }
  return versions;
}

/** Save hand edits and tool writes at a turn boundary. An empty first snapshot
 * distinguishes a new conversation without a course from unversioned history. */
export async function recordCourseVersions(
  deps: CourseVersionDeps,
  input: {
    phase: CourseVersionsEntryData['phase'];
    status?: string;
    extraStageIds?: Iterable<string>;
  },
): Promise<CourseVersionsEntryData['versions']> {
  const path = (await deps.session.getBranch()) as unknown as TreeEntry[];
  const onPath = courseVersionsOnPath(path);
  const versions = await snapshotStages(
    deps,
    [...onPath.keys(), deps.defaultStageId, ...(input.extraStageIds ?? [])],
    input.phase,
  );
  const previous = lastVersionBoundary(path);
  if (
    !previous ||
    previous.unavailable ||
    versions.some(({ stageId, versionId }) => onPath.get(stageId) !== versionId)
  ) {
    await deps.writeEntry(async () => {
      await deps.session.appendCustomEntry(COURSE_VERSIONS_ENTRY, {
        phase: input.phase,
        versions,
        ...(input.status ? { status: input.status } : {}),
      });
    });
  }
  return versions;
}

export interface ApplyBranchResult {
  outcomes: BranchOutcome[];
  regenerated: boolean;
}

interface BranchTransaction {
  withTransaction: (
    apply: (deps: CourseVersionDeps) => Promise<BranchOutcome>,
  ) => Promise<BranchOutcome>;
  hasPendingMedia: () => boolean;
  createdStageIds?: ReadonlySet<string>;
}

/** One transaction covers all courses, the source snapshot and the leased
 * tree cursor. A failed write rolls all three back, including on process exit. */
export async function applyBranchRequests(
  deps: BranchTransaction,
  requests: readonly { seq: number; data: unknown }[],
): Promise<ApplyBranchResult> {
  const outcomes: BranchOutcome[] = [];
  let regenerated = false;
  for (const { seq: requestSeq, data } of requests) {
    const request = parseBranchRequest(data);
    if (!request) {
      outcomes.push({ requestSeq, op: 'unknown', status: 'rejected', reason: 'invalid_request' });
      continue;
    }
    const op = request.op;
    let failure: BranchOutcome['reason'] = 'apply_failed';
    let checkedPrevious = false;
    let readyToCommit = false;
    try {
      const outcome = await deps.withTransaction(async (tx): Promise<BranchOutcome> => {
        const entries = (await tx.session.getEntries()) as unknown as TreeEntry[];
        const previous = beforeSwitchEntryOf(entries, requestSeq);
        const saved = previous?.data as
          | (CourseVersionsEntryData & { checkedOut?: Checkout[] })
          | undefined;
        // The lifecycle receipt may be pending after a crash. The matching
        // snapshot and the move it describes committed together.
        if (saved?.checkedOut) {
          readyToCommit = true;
          return { requestSeq, op, status: 'applied', checkedOut: saved.checkedOut };
        }
        checkedPrevious = true;
        if (deps.hasPendingMedia())
          return { requestSeq, op, status: 'rejected', reason: 'media_pending' };
        const move = planBranchMove(entries, request, requestSeq);
        if (move.kind === 'reject')
          return { requestSeq, op, status: 'rejected', reason: move.reason };
        const sourcePath = (await tx.session.getBranch()) as unknown as TreeEntry[];
        const staying = op === 'switch' && move.leafId === sourcePath.at(-1)?.id;
        const targetPath = move.leafId
          ? ((await tx.session.getBranch(move.leafId)) as unknown as TreeEntry[])
          : [];
        const target = courseVersionsOnPath(targetPath);
        const sourceIds = new Set(
          [...courseVersionsOnPath(sourcePath).keys(), tx.defaultStageId].filter(Boolean),
        );
        const baseline = lastVersionBoundary(targetPath);
        const opening =
          op === 'regenerate' &&
          findUserEntry(entries, request.targetSeq)?.id === findUserEntry(entries, 0)?.id;
        // A course first named on the branch being left can predate this
        // conversation. Restore its earliest recorded pre-turn state. A
        // create_stage receipt proves that a new course can stay in the library.
        if (!staying && !opening) {
          for (const stageId of sourceIds) {
            if (
              target.has(stageId) ||
              stageId === tx.defaultStageId ||
              deps.createdStageIds?.has(stageId)
            )
              continue;
            const first = sourcePath.flatMap((entry) => {
              const data =
                entry.type === 'custom' && entry.customType === COURSE_VERSIONS_ENTRY
                  ? (entry.data as CourseVersionsEntryData)
                  : undefined;
              const version = data?.versions.find((value) => value.stageId === stageId);
              return version ? [{ versionId: version.versionId, phase: data!.phase }] : [];
            })[0];
            if (first?.phase !== 'before_run')
              return { requestSeq, op, status: 'rejected', reason: 'version_unavailable' };
            target.set(stageId, first.versionId);
          }
        }
        const affectedStages = [...new Set([...sourceIds, ...target.keys()])].sort();
        await lockCourseVersionStages(tx.db.queryable, tx.ownerId, affectedStages, [
          ...target.values(),
        ]);
        const versions =
          saved?.versions ?? (await snapshotStages(tx, affectedStages, 'before_switch'));
        if (staying) for (const { stageId, versionId } of versions) target.set(stageId, versionId);
        if (!staying && (baseline?.unavailable || (versions.length && !opening && !baseline))) {
          // The source snapshot can be the first evidence that this older
          // conversation already has a live course. Roll its asset roots
          // and page rows back with the refused move.
          failure = 'version_unavailable';
          throw new Error('No course version was recorded for this turn');
        }
        const checkedOut: Checkout[] = [];
        failure = 'checkout_failed';
        for (const [stageId, versionId] of [...target].sort(([a], [b]) => a.localeCompare(b))) {
          const alreadyHere =
            !previous &&
            versions.some(
              (version) => version.stageId === stageId && version.versionId === versionId,
            );
          const restored = alreadyHere
            ? 'unchanged'
            : await checkoutCourseVersion(tx.db, { ownerId: tx.ownerId, stageId, versionId });
          checkedOut.push({ stageId, versionId, outcome: restored });
        }
        failure = 'apply_failed';
        await tx.writeEntry(async () => {
          if (previous && previous.id !== sourcePath.at(-1)?.id)
            await tx.session.moveTo(previous.id);
          await tx.session.appendCustomEntry(COURSE_VERSIONS_ENTRY, {
            phase: 'before_switch',
            versions,
            requestSeq,
            checkedOut,
          });
          // Switching to the branch already on screen keeps its newly saved
          // hand edits and its request receipt at the tip.
          if (!staying) await tx.session.moveTo(move.leafId);
          if (move.replyVariant)
            await tx.session.appendCustomEntry(REPLY_VARIANT_ENTRY, move.replyVariant);
        });
        readyToCommit = true;
        return { requestSeq, op, status: 'applied', checkedOut };
      });
      outcomes.push(outcome);
      if (outcome.status === 'applied') regenerated = op === 'regenerate';
    } catch (error) {
      // A disconnected COMMIT has an unknown outcome. The next claim reads
      // the durable receipt before retrying and can report its exact result.
      if (!checkedPrevious || readyToCommit) throw error;
      outcomes.push({ requestSeq, op, status: 'rejected', reason: failure });
    }
  }
  return { outcomes, regenerated };
}
