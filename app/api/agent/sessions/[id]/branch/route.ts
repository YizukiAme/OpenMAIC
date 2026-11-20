/** Durable edits, regenerations and branch switches in Pro conversations. */
import { AgentSessionAccessError } from '@openmaic/storage';
import type { AgentSessionStatus } from '@openmaic/storage';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { HOST_AGENT_LIFECYCLE } from '@/lib/agent-runtime/lifecycle';
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { isPBLRoleSession } from '@/lib/pbl/v3/session-kind';
import {
  fenceOwnerWrite,
  ownerRetiredResponseIfRetired,
  ownerWriteErrorResponse,
} from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { listPendingMediaTasks } from '@/lib/server/agent-runtime/pending-media';
import {
  bindOwnerMaterialsToSession,
  getAgentSessionMaterialStore,
  SessionMaterialBindingError,
} from '@/lib/server/agent-runtime/session-materials';
import { agentSessionStoreIn, getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { readAgentMessageLog } from '@/lib/server/agent-runtime/user-messages';
import {
  parseUserMessageInput,
  type UserMessageBody,
} from '@/lib/server/agent-runtime/user-message-input';
import { apiError, type ApiErrorCode } from '@/lib/server/api-response';
import { readCourseVersion } from '@/lib/server/course-versions/store';
import {
  courseVersionsOnPath,
  lastVersionBoundary,
  planBranchMove,
  parseBranchRequest,
} from '@/lib/server/course-versions/tree';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { assertWorkspaceModelsAuthorized } from '@/lib/server/model-config/runtime';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const missing = () => new Response('Not found', { status: 404, headers });
    const fail = (code: ApiErrorCode, status: number, message: string) => {
      const response = apiError(code, status, message);
      headers.forEach((value, name) => response.headers.append(name, value));
      return response;
    };
    const { id } = await params;
    if (isPBLRoleSession(id)) return missing();
    const store = await getAgentSessionStore();
    const meta = await store.getSession(id);
    if (!meta || meta.ownerId !== ownerId) return missing();

    let body: UserMessageBody & { op?: unknown; targetSeq?: unknown; variant?: unknown };
    try {
      body = (await req.json()) ?? {};
    } catch {
      return fail('INVALID_REQUEST', 400, 'invalid JSON body');
    }
    const request = parseBranchRequest(body);
    if (!request) return fail('INVALID_REQUEST', 400, 'op, targetSeq or variant is invalid');
    if (request.op === 'edit' && request.targetSeq === 0) {
      return fail('INVALID_REQUEST', 400, 'the opening message cannot be edited');
    }
    const busy = (status: AgentSessionStatus) =>
      NextResponse.json(
        { code: 'SESSION_BUSY', status, error: `session is ${status}` },
        { status: 409, headers },
      );
    if (meta.status === 'queued' || meta.status === 'running') return busy(meta.status);
    if (
      listPendingMediaTasks().some((task) => task.sessionId === id && task.status === 'generating')
    ) {
      return NextResponse.json(
        { code: 'MEDIA_PENDING', error: 'media for this conversation is still generating' },
        { status: 409, headers },
      );
    }

    let original: UserMessageBody & { materials?: unknown } = {};
    if (request.targetSeq > 0) {
      const [target] = await store.readEventsAfter(id, request.targetSeq - 1, 1);
      if (target?.id !== request.targetSeq || target.type !== HOST_AGENT_LIFECYCLE.userMessage) {
        return fail('INVALID_REQUEST', 404, 'the target message is not in this conversation');
      }
      original = (target.data ?? {}) as typeof original;
    }
    // Reuse the original session's material receipts, including historical copies
    // and file paths which are not owner-library material IDs.
    const retained =
      body.materialIds === undefined && Array.isArray(original.materials) ? original.materials : [];
    const edited =
      request.op === 'edit'
        ? parseUserMessageInput(
            {
              ...body,
              elementRefs: body.elementRefs ?? original.elementRefs,
              courseRefs: body.courseRefs ?? original.courseRefs,
              locale: body.locale ?? original.locale,
            },
            retained,
          )
        : null;
    if (edited && !edited.ok) return fail(edited.code, 400, edited.message);
    if (request.op !== 'switch') {
      await assertWorkspaceModelsAuthorized(ownerId, [
        'agent',
        'image',
        'video',
        'tts',
        'asr',
        'webSearch',
      ]);
    }

    try {
      if (edited?.ok && edited.input.materialIds.length) await getAgentSessionMaterialStore();
      const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      return await provider.withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        // The same row lock serializes posting a message, claiming a run, and
        // accepting a branch. The runner can only see a complete request.
        const locked = await tx.query<{
          status: AgentSessionStatus;
          open_question_seq: number | null;
          delivered_user_message_seq: number;
          later_message: boolean;
        }>(
          `SELECT s.status, s.open_question_seq, s.delivered_user_message_seq,
                  EXISTS (SELECT 1 FROM agent_session_events e WHERE e.session_id = s.id
                          AND e.seq > s.delivered_user_message_seq AND e.type = 'user_message') AS later_message
             FROM agent_sessions s WHERE s.id = $1 AND s.owner_id = $2 AND s.deleted_at IS NULL
             FOR UPDATE OF s`,
          [id, ownerId],
        );
        const status = locked.rows[0]?.status;
        if (!status) return missing();
        if (status === 'queued' || status === 'running') return busy(status);
        if (locked.rows[0]?.open_question_seq != null) {
          return NextResponse.json(
            {
              code: 'QUESTION_PENDING',
              error: 'Answer the current question before changing branches.',
            },
            { status: 409, headers },
          );
        }
        const writer = agentSessionStoreIn(tx);
        const row = locked.rows[0]!;
        if (row.later_message || status === 'failed' || status === 'cancelled') {
          const log = await readAgentMessageLog(writer, id);
          if (
            log.pendingBranches?.length ||
            log.messages.some((m) => m.seq > row.delivered_user_message_seq)
          ) {
            return NextResponse.json(
              {
                code: 'MESSAGE_PENDING',
                error:
                  'Continue the current conversation to deliver its pending message before changing branches.',
              },
              { status: 409, headers },
            );
          }
        }
        const requestSeq = await writer.appendControlEvent(id, {
          ts: Date.now(),
          type: HOST_AGENT_LIFECYCLE.branchRequest,
          data: request,
        });
        if (requestSeq === null) return missing();
        let message;
        if (edited?.ok) {
          const { text, materialIds, elementRefs, courseRefs, locale } = edited.input;
          const materials = materialIds.length
            ? await bindOwnerMaterialsToSession(id, ownerId, materialIds, tx)
            : retained;
          const posted = await writer.postUserMessage(
            id,
            {
              text,
              ...(materials.length ? { materials } : {}),
              ...(elementRefs.length ? { elementRefs } : {}),
              ...(courseRefs.length ? { courseRefs } : {}),
              ...(locale ? { locale } : {}),
            },
            { expectedOwnerId: ownerId },
          );
          message = { seq: posted.seq, text };
        } else {
          await writer.requeueSession(id);
        }
        return NextResponse.json(
          { id, requestSeq, op: request.op, ...(message ? { message } : {}) },
          { status: 202, headers },
        );
      });
    } catch (error) {
      if (error instanceof SessionMaterialBindingError) return missing();
      if (error instanceof AgentSessionAccessError) {
        return (
          (await ownerRetiredResponseIfRetired(ownerId, headers)) ??
          new Response('Forbidden', { status: 403, headers })
        );
      }
      const claimed = ownerWriteErrorResponse(error, headers);
      if (claimed) return claimed;
      throw error;
    }
  });
}

/** Browsing a saved version leaves the worker's cursor and live documents alone. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const { id } = await params;
    const store = await getAgentSessionStore();
    const meta = await store.getSession(id);
    if (!meta || meta.ownerId !== ownerId || isPBLRoleSession(id))
      return new Response('Not found', { status: 404, headers });
    const query = req.nextUrl.searchParams;
    const variant = query.get('variant');
    const request = parseBranchRequest({
      op: 'switch',
      targetSeq: query.has('targetSeq') ? Number(query.get('targetSeq')) : undefined,
      variant: variant === null ? undefined : variant === 'orig' ? variant : Number(variant),
    });
    if (!request) return new Response('Invalid version', { status: 400, headers });
    const tree = await store.openEntryTree(id, 'branch-preview', meta.attempt);
    const move = planBranchMove(await tree.getEntries(), request, 0);
    if (move.kind !== 'move') return new Response('Not found', { status: 404, headers });
    const path = await tree.getPathToRoot(move.leafId);
    const versions = courseVersionsOnPath(path);
    if (!versions.size || lastVersionBoundary(path)?.unavailable)
      return NextResponse.json(null, { headers });
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const preview = await readCourseVersion(
      pool,
      ownerId,
      [...versions.values()],
      query.get('course'),
    );
    return NextResponse.json(preview, { headers });
  });
}
