import { isPBLRoleSession } from '@/lib/pbl/v3/session-kind';
/** Agent runtime control plane for durable follow-up messages. */
import { assertWorkspaceModelsAuthorized } from '@/lib/server/model-config/runtime';
import { AgentSessionAccessError } from '@openmaic/storage';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { scheduleConversationTitle } from '@/lib/server/agent-runtime/conversation-title-task';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  ownerRetiredResponseIfRetired,
  ownerWriteErrorResponse,
} from '@/lib/persistence/owner-merges';
import {
  parseUserMessageInput,
  type UserMessageBody,
} from '@/lib/server/agent-runtime/user-message-input';
import {
  bindOwnerMaterialsToSession,
  SessionMaterialBindingError,
} from '@/lib/server/agent-runtime/session-materials';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404 });
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    if (isPBLRoleSession(id))
      return new Response('Not found', { status: 404, headers: responseHeaders });
    const store = await getAgentSessionStore();
    const meta = await store.getSession(id);
    if (!meta || meta.ownerId !== ownerId) {
      return new Response('Not found', { status: 404, headers: responseHeaders });
    }

    let body: UserMessageBody = {};
    try {
      body = ((await req.json()) ?? {}) as UserMessageBody;
    } catch {
      const response = apiError('INVALID_REQUEST', 400, 'invalid JSON body');
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }

    const parsed = parseUserMessageInput(body);
    if (!parsed.ok) {
      const response = apiError(parsed.code, 400, parsed.message);
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    const { text, materialIds, locale } = parsed.input;
    const decodedElementRefs = { refs: parsed.input.elementRefs };
    const decodedCourseRefs = { refs: parsed.input.courseRefs };

    await assertWorkspaceModelsAuthorized(ownerId, [
      'agent',
      'agent.title',
      'image',
      'video',
      'tts',
      'asr',
      'webSearch',
    ]);
    try {
      const materials = materialIds.length
        ? await bindOwnerMaterialsToSession(id, ownerId, materialIds)
        : [];
      const posted = await store.postUserMessage(
        id,
        {
          text,
          ...(materials.length ? { materials } : {}),
          ...(decodedElementRefs.refs.length ? { elementRefs: decodedElementRefs.refs } : {}),
          ...(decodedCourseRefs.refs.length ? { courseRefs: decodedCourseRefs.refs } : {}),
          ...(locale ? { locale } : {}),
        },
        { expectedOwnerId: ownerId },
      );
      if (text) scheduleConversationTitle(id, ownerId);
      return NextResponse.json(
        {
          id,
          message: { seq: posted.seq, text, delivery: posted.delivery },
          elementRefsAccepted: decodedElementRefs.refs.length > 0,
          courseRefsAccepted: decodedCourseRefs.refs.length > 0,
        },
        { status: 202, headers: responseHeaders },
      );
    } catch (error) {
      if (error instanceof SessionMaterialBindingError) {
        return new Response('Not found', { status: 404, headers: responseHeaders });
      }
      if (error instanceof AgentSessionAccessError) {
        // A retired identity: the session moved with the claim.
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
