import { isPBLRoleSession } from '@/lib/pbl/v3/session-kind';
/**
 * Agent runtime control plane for edit-and-resend (#1317, prototype).
 *
 * POST { op: 'regenerate' | 'edit' | 'switch', targetSeq, variant?, ...message }
 *
 * - `regenerate`: answer the user message `targetSeq` again, on a new branch.
 * - `edit`: send the message fields in the body as a new version of the user
 *   message `targetSeq`, on a new branch.
 * - `switch`: put the conversation, and the courses it wrote, on another
 *   branch: user message `targetSeq` (one of an edited message's versions), or
 *   its reply `variant` (`'orig'` or the regenerate request that produced it).
 *
 * `targetSeq` is the durable `user_message` event sequence; `0` names the
 * session's opening prompt.
 *
 * Like the cancel route, this one only makes the request durable: it appends a
 * `branch_request` event and requeues the session (or, for an edit, posts the
 * edited message, which requeues it). The runner, the single writer of the
 * entry tree, applies the request under its lease before it plans the run,
 * and reports the outcome on the run's first lifecycle frame.
 *
 * A session that is running answers 409 `SESSION_BUSY`: the client stops the
 * run first (the cancel route) and sends the request once it has ended, so a
 * branch never moves under a run that is still writing.
 */
import { assertWorkspaceModelsAuthorized } from '@/lib/server/model-config/runtime';
import { AgentSessionAccessError } from '@openmaic/storage';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError, type ApiErrorCode } from '@/lib/server/api-response';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { listPendingMediaTasks } from '@/lib/server/agent-runtime/pending-media';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  ownerRetiredResponseIfRetired,
  ownerWriteErrorResponse,
} from '@/lib/persistence/owner-merges';
import {
  bindOwnerMaterialsToSession,
  SessionMaterialBindingError,
} from '@/lib/server/agent-runtime/session-materials';
import {
  parseUserMessageInput,
  type UserMessageBody,
} from '@/lib/server/agent-runtime/user-message-input';
import { BRANCH_REQUEST_EVENT } from '@/lib/server/course-versions/branching';
import { parseBranchRequest } from '@/lib/server/course-versions/tree';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404 });
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const fail = (code: ApiErrorCode, status: number, message: string) => {
      const response = apiError(code, status, message);
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    };
    const { id } = await params;
    if (isPBLRoleSession(id))
      return new Response('Not found', { status: 404, headers: responseHeaders });
    const store = await getAgentSessionStore();
    const meta = await store.getSession(id);
    if (!meta || meta.ownerId !== ownerId) {
      return new Response('Not found', { status: 404, headers: responseHeaders });
    }

    let body: UserMessageBody & { op?: unknown; targetSeq?: unknown; variant?: unknown } = {};
    try {
      body = ((await req.json()) ?? {}) as typeof body;
    } catch {
      return fail('INVALID_REQUEST', 400, 'invalid JSON body');
    }
    const request = parseBranchRequest({
      op: body.op,
      targetSeq: body.targetSeq,
      variant: body.variant,
    });
    if (!request) {
      return fail('INVALID_REQUEST', 400, 'op, targetSeq or variant is invalid');
    }
    const message = request.op === 'edit' ? parseUserMessageInput(body) : null;
    if (message && !message.ok) return fail(message.code, 400, message.message);
    if (request.op === 'edit' && request.targetSeq === 0) {
      return fail('INVALID_REQUEST', 400, 'the opening message cannot be edited');
    }

    // A run still writing would race the branch move: the client stops it first.
    if (meta.status === 'queued' || meta.status === 'running') {
      return NextResponse.json(
        { code: 'SESSION_BUSY', status: meta.status, error: `session is ${meta.status}` },
        { status: 409, headers: responseHeaders },
      );
    }
    // A detached media job patches the live course when it finishes; moving the
    // course to another branch first would let that patch land on the wrong one.
    if (
      listPendingMediaTasks().some((task) => task.sessionId === id && task.status === 'generating')
    ) {
      return NextResponse.json(
        { code: 'MEDIA_PENDING', error: 'media for this conversation is still generating' },
        { status: 409, headers: responseHeaders },
      );
    }
    if (request.targetSeq > 0) {
      const messages = await store.listUserMessages(id);
      if (!messages.some((posted) => posted.seq === request.targetSeq)) {
        return fail('INVALID_REQUEST', 404, 'the target message is not in this conversation');
      }
    }

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
      const materials =
        message?.ok && message.input.materialIds.length
          ? await bindOwnerMaterialsToSession(id, ownerId, message.input.materialIds)
          : [];
      const requestSeq = await store.appendControlEvent(id, {
        ts: Date.now(),
        type: BRANCH_REQUEST_EVENT,
        data: request,
      });
      if (requestSeq === null) {
        return new Response('Not found', { status: 404, headers: responseHeaders });
      }
      if (message?.ok) {
        const { text, elementRefs, courseRefs, locale } = message.input;
        const posted = await store.postUserMessage(
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
        return NextResponse.json(
          { id, requestSeq, op: request.op, message: { seq: posted.seq, text } },
          { status: 202, headers: responseHeaders },
        );
      }
      // The request is durable either way: if another write requeued the
      // session first, the claim it starts applies this request too.
      await store.requeueSession(id);
      return NextResponse.json(
        { id, requestSeq, op: request.op },
        { status: 202, headers: responseHeaders },
      );
    } catch (error) {
      if (error instanceof SessionMaterialBindingError) {
        return new Response('Not found', { status: 404, headers: responseHeaders });
      }
      if (error instanceof AgentSessionAccessError) {
        const retired = await ownerRetiredResponseIfRetired(ownerId, responseHeaders);
        if (retired) return retired;
        return new Response('Forbidden', { status: 403, headers: responseHeaders });
      }
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      throw error;
    }
  });
}
