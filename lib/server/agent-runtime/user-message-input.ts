/**
 * The body of a follow-up user message, validated once for every route that
 * posts one: `POST /api/agent/sessions/:id/messages`, and the edit branch of
 * `POST /api/agent/sessions/:id/branch` (#1317), which posts the edited text.
 */
import { supportedLocaleOf } from '@/lib/i18n/types';
import { MAX_SESSION_TEXT_LENGTH } from '@/lib/server/agent-runtime/limits';
import { decodeCourseRefs } from '@/lib/workbench/course-refs';
import { decodeElementRefs } from '@/lib/workbench/element-refs';

export interface UserMessageBody {
  text?: unknown;
  materialIds?: unknown;
  elementRefs?: unknown;
  courseRefs?: unknown;
  /** The interface language the message is sent from; an unsupported value is ignored. */
  locale?: unknown;
}

type ElementRefs = Extract<ReturnType<typeof decodeElementRefs>, { ok: true }>['refs'];
type CourseRefs = Extract<ReturnType<typeof decodeCourseRefs>, { ok: true }>['refs'];

export interface UserMessageInput {
  text: string;
  materialIds: string[];
  elementRefs: ElementRefs;
  courseRefs: CourseRefs;
  locale?: NonNullable<ReturnType<typeof supportedLocaleOf>>;
}

export type UserMessageInputResult =
  | { ok: true; input: UserMessageInput }
  | { ok: false; code: 'INVALID_REQUEST' | 'MISSING_REQUIRED_FIELD'; message: string };

export function parseUserMessageInput(body: UserMessageBody): UserMessageInputResult {
  const text = String(body.text ?? '').trim();
  if (
    body.materialIds !== undefined &&
    (!Array.isArray(body.materialIds) || body.materialIds.some((id) => typeof id !== 'string'))
  ) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'materialIds must be an array of strings',
    };
  }
  const materialIds = [
    ...new Set(((body.materialIds as string[] | undefined) ?? []).map((id) => id.trim())),
  ];
  if (materialIds.length > 20 || materialIds.some((id) => !id)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'materialIds are invalid' };
  }
  const decodedElementRefs = decodeElementRefs(body.elementRefs ?? []);
  if (!decodedElementRefs.ok) {
    return { ok: false, code: 'INVALID_REQUEST', message: decodedElementRefs.error };
  }
  const decodedCourseRefs = decodeCourseRefs(body.courseRefs ?? []);
  const locale = supportedLocaleOf(body.locale);
  if (!decodedCourseRefs.ok) {
    return { ok: false, code: 'INVALID_REQUEST', message: decodedCourseRefs.error };
  }
  if (!text && materialIds.length === 0) {
    return { ok: false, code: 'MISSING_REQUIRED_FIELD', message: 'text is required' };
  }
  if (text.length > MAX_SESSION_TEXT_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: `text exceeds the ${MAX_SESSION_TEXT_LENGTH} character limit`,
    };
  }
  return {
    ok: true,
    input: {
      text,
      materialIds,
      elementRefs: decodedElementRefs.refs,
      courseRefs: decodedCourseRefs.refs,
      ...(locale ? { locale } : {}),
    },
  };
}
