import { isRunLive } from '@/components/workbench/chat/composer-send-state';
import { flushStageSave } from '@/lib/store/stage';
import type { BranchReceipt } from './branch-fold';
import { samePanes, withCourse, type WorkspacePanes } from './workspace-panes';
import {
  branchWorkbenchSession,
  cancelWorkbenchSession,
  recoverTerminalCancelStatus,
  useWorkbenchStore,
  WorkbenchApiError,
  type ChatNode,
  type WorkbenchBranchRequest,
} from './session-store';

const WAIT_MS = 30_000;

/** Follow the reply in an open classroom if the user stayed there during checkout. */
export function panesAfterBranchSwitch(
  started: WorkspacePanes,
  current: WorkspacePanes,
  chat: readonly ChatNode[],
  checkedOut: BranchReceipt['checkedOut'],
): WorkspacePanes | null {
  if (!current.courseId || !samePanes(started, current)) return null;
  const available =
    checkedOut?.filter((course) => course.outcome !== 'missing').map((course) => course.stageId) ??
    [];
  const card = chat.findLast(
    (node) => node.kind === 'course' && node.stageIds?.some((id) => available.includes(id)),
  );
  const choices = card?.stageIds?.filter((id) => available.includes(id)) ?? available;
  if (!choices.length || choices.includes(current.courseId)) return null;
  return withCourse(current, choices[0]);
}

/** POST acknowledges queuing. Only the worker's lifecycle receipt confirms a checkout. */
function waitForReceipt(seq: number, current: () => boolean): Promise<BranchReceipt | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new WorkbenchApiError('Waiting for branch confirmation', 408, 'BRANCH_QUEUED'));
    }, WAIT_MS);
    const check = () => {
      const receipt = useWorkbenchStore.getState().branch?.lastReceipt;
      if (current() && (!receipt || receipt.requestSeq < seq)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(current() && receipt?.requestSeq === seq ? receipt : null);
    };
    const unsubscribe = useWorkbenchStore.subscribe(check);
    check();
  });
}

export async function changeWorkbenchBranch(
  sessionId: string,
  request: WorkbenchBranchRequest,
  {
    pendingSend = false,
    stillHere = () => true,
    onStopping,
  }: {
    pendingSend?: boolean;
    stillHere?: () => boolean;
    onStopping?: () => void;
  } = {},
): Promise<BranchReceipt | null> {
  const current = () => stillHere() && useWorkbenchStore.getState().sessionId === sessionId;
  if (!current()) return null;
  if (pendingSend || isRunLive(useWorkbenchStore.getState().status)) {
    onStopping?.();
    // The terminal frame can precede the database commit. A queued send can
    // also still look terminal locally. Check the row the branch route admits.
    const stopSignal = AbortSignal.timeout(WAIT_MS);
    try {
      await cancelWorkbenchSession(sessionId, stopSignal);
      while (current()) {
        const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
          signal: stopSignal,
        });
        if (!response.ok) throw new Error('Could not read session status');
        const { status } = await response.json();
        if (status === 'cancelled' || status === 'succeeded' || status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      if (stopSignal.aborted)
        throw new WorkbenchApiError('Stopping timed out', 408, 'STOP_TIMEOUT');
      if (!recoverTerminalCancelStatus(sessionId, error)) throw error;
    }
  }
  if (!current()) return null;
  // Preserve a title, page or outline still in the editor's autosave debounce.
  try {
    await flushStageSave();
  } catch {
    throw new WorkbenchApiError('Could not save course edits', 409, 'COURSE_SAVE_FAILED');
  }
  if (!current()) return null;
  const seq = await branchWorkbenchSession(sessionId, request);
  return waitForReceipt(seq, current);
}
