import type { AgentSessionUserMessage } from '@openmaic/storage';
import type { PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import { HOST_AGENT_LIFECYCLE } from '@/lib/agent-runtime/lifecycle';
import type { BranchRequestData } from '@/lib/server/course-versions/tree';

export interface AgentUserMessageWithElementRefs extends AgentSessionUserMessage {
  elementRefs?: unknown[];
  /** This delivery depends on an accepted edit of an earlier turn. */
  branchEdit?: true;
  /** Server-created PBL stage entry, never learner feedback. */
  pblOpening?: boolean;
  /** PBL interface locale, not message text or evidence of learner understanding. */
  pblUiLocale?: string;
}

export interface DetachedSessionSkill {
  skillName: string;
  throughMessageSeq: number;
}

export interface PendingBranchRequest {
  seq: number;
  data: BranchRequestData;
  editMessage?: AgentUserMessageWithElementRefs;
}

/**
 * Read user messages from their authoritative event JSON. The storage package's
 * compatibility projection currently omits elementRefs even though it persists
 * them, so the application runner uses this adapter until that surface catches up.
 */
export async function listAgentUserMessages(
  store: Pick<PgAgentSessionStore, 'readEventsAfter' | 'listUserMessages'>,
  sessionId: string,
): Promise<AgentUserMessageWithElementRefs[]> {
  return (await readAgentMessageLog(store, sessionId)).messages;
}

/** Read recovery receipts with their message boundary, including after a restart. */
export async function readAgentMessageLog(
  store: Pick<PgAgentSessionStore, 'readEventsAfter' | 'listUserMessages'>,
  sessionId: string,
): Promise<{
  messages: AgentUserMessageWithElementRefs[];
  detachedSkills: DetachedSessionSkill[];
  openingMessageSeq?: number;
  pendingBranches?: PendingBranchRequest[];
  createdStageIds?: Set<string>;
  /** A crashed worker may already have written a switch-only terminal frame. */
  branchOnlyEnd?: true;
}> {
  // Lightweight runner fakes and compatibility implementations may expose only
  // the old projection. Production PgAgentSessionStore always takes the event path.
  if (typeof store.readEventsAfter !== 'function') {
    return { messages: await store.listUserMessages(sessionId), detachedSkills: [] };
  }
  const messages: AgentUserMessageWithElementRefs[] = [];
  const detachedSkills: DetachedSessionSkill[] = [];
  const requests = new Map<number, PendingBranchRequest>();
  const heldEdits = new Set<number>();
  const createdStageIds = new Set<string>();
  let branchOnlyEnd = false;
  let priorRunSeen = false;
  let openingMessageSeq: number | undefined;
  let cursor = 0;
  for (;;) {
    const events = await store.readEventsAfter(sessionId, cursor, 500);
    for (const event of events) {
      const data =
        event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
      if (event.type === HOST_AGENT_LIFECYCLE.branchRequest) {
        requests.set(event.id, { seq: event.id, data: event.data as BranchRequestData });
        continue;
      }
      if (
        event.type === HOST_AGENT_LIFECYCLE.libraryChanged &&
        data.change === 'stage_created' &&
        typeof data.stageId === 'string'
      ) {
        createdStageIds.add(data.stageId);
      }
      if (
        event.type === HOST_AGENT_LIFECYCLE.sessionStart ||
        event.type === HOST_AGENT_LIFECYCLE.sessionResumed ||
        event.type === HOST_AGENT_LIFECYCLE.sessionEnd ||
        event.type === HOST_AGENT_LIFECYCLE.sessionInterrupted
      ) {
        priorRunSeen = true;
        branchOnlyEnd =
          event.type === HOST_AGENT_LIFECYCLE.sessionEnd && data.note === 'branch requests only';
        for (const outcome of Array.isArray(data.branches) ? data.branches : []) {
          const request = requests.get(outcome?.requestSeq);
          if (!request) continue;
          if (request.editMessage && outcome.status === 'applied')
            heldEdits.delete(request.editMessage.seq);
          requests.delete(request.seq);
        }
      }
      if (
        event.type === HOST_AGENT_LIFECYCLE.skillDetached &&
        typeof data.skillName === 'string' &&
        typeof data.throughMessageSeq === 'number' &&
        Number.isSafeInteger(data.throughMessageSeq) &&
        data.throughMessageSeq >= 0
      ) {
        detachedSkills.push({
          skillName: data.skillName,
          throughMessageSeq: data.throughMessageSeq,
        });
      }
      if (event.type !== HOST_AGENT_LIFECYCLE.userMessage) continue;
      // A text-only opener can live solely in session metadata. In that case
      // the first durable user message, posted after a run, is a fresh follow-up.
      if (!priorRunSeen && messages.length === 0) openingMessageSeq = event.id;
      const message: AgentUserMessageWithElementRefs = {
        seq: event.id,
        ts: event.ts,
        text: String(data.text ?? ''),
        ...(sessionId.startsWith('pbl-role-') && data.pblOpening === true
          ? { pblOpening: true }
          : {}),
        ...(sessionId.startsWith('pbl-role-') && typeof data.pblUiLocale === 'string'
          ? { pblUiLocale: data.pblUiLocale }
          : {}),
        delivery: String(data.delivery ?? ''),
        materials: Array.isArray(data.materials) ? data.materials : [],
        ...(Array.isArray(data.elementRefs) ? { elementRefs: data.elementRefs } : {}),
        ...(Array.isArray(data.courseRefs) ? { courseRefs: data.courseRefs } : {}),
        ...(typeof data.locale === 'string' && data.locale ? { locale: data.locale } : {}),
      };
      // Admission writes the edit and its request as two consecutive records
      // in one transaction. Only the runner's durable receipt releases it to
      // delivery, including after a crash or a later ordinary follow-up.
      const request = requests.get(event.id - 1);
      if (request?.data?.op === 'edit') {
        message.branchEdit = true;
        request.editMessage = message;
        heldEdits.add(message.seq);
      }
      messages.push(message);
    }
    if (events.length < 500)
      return {
        messages: heldEdits.size
          ? messages.filter((message) => !heldEdits.has(message.seq))
          : messages,
        detachedSkills,
        ...(openingMessageSeq !== undefined ? { openingMessageSeq } : {}),
        ...(requests.size ? { pendingBranches: [...requests.values()] } : {}),
        ...(createdStageIds.size ? { createdStageIds } : {}),
        ...(branchOnlyEnd ? { branchOnlyEnd: true } : {}),
      };
    cursor = events[events.length - 1]!.id;
  }
}
