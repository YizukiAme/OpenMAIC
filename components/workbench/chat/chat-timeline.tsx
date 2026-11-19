'use client';

/**
 * Chat timeline — the folded chat as render rows.
 *
 * One grouping rule, computed on render (no grouping state is stored, so a
 * replayed log groups identically to a live one): everything the agent did
 * between two things that mean something on their own (thinking, tools, the
 * pre-token wait) is one row. Prose ends the row; so do a question, a notice, a
 * course card, a stop or the user speaking, none of which is ever folded away.
 * Consecutive identical system notices collapse too, into one row with a count.
 *
 * Single-agent layout, after the PR5 supervision-layer removal: the
 * assistant's prose floats (no container), actions (tool cards, thinking
 * bars) are boxed, the user is a solid right-side bubble, and system markers
 * are a small icon with one muted line (a tinted notice card when they carry a
 * failure). There are deliberately no skill announcements and no
 * constraint-violation chips — the agent says what it picked in prose, and
 * machine-check results stay in tool results for the agent.
 *
 * The one row that is not a record of something that happened is the `ask_user`
 * question card: it is a hand-over, so it gets its own line and the host's send
 * path (`onAnswer`).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { CircleSlash2 } from 'lucide-react';
import { courseCardExclusions } from '@/lib/workbench/course-link';
import type { ChatNode, PlannedPage } from '@/lib/workbench/session-store';
import type { BranchFork, BranchSegment } from '@/lib/workbench/branch-fold';
import { ReplyTurnControls, UserBubbleEditor, UserTurnControls } from './branch-controls';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { wbStyles as styles } from './chat-styles';
import { ActionCluster } from './action-cluster';
import { SessionCourseLink } from './course-link';
import { QuestionCard, type QuestionPointer } from './question-card';
import { SystemNode } from './system-node';
import { isSameNotice, presentSystemNotice, repeatLabel, repeatTitle } from './system-notice';
import { TextBlock } from './text-block';
import { UserBubble } from './user-bubble';
import { isHiddenWorkbenchTool } from './tool-presentation';

interface ChatRow {
  key: string;
  node?: ChatNode;
  group?: ChatNode[];
  /**
   * How many identical consecutive system notices this row stands for (1 for
   * every other row). Computed here rather than folded: the timeline data keeps
   * every marker, so a replay re-derives the same count instead of inheriting a
   * collapsed history.
   */
  repeat?: number;
}

function isActionBar(node: ChatNode): boolean {
  return node.kind === 'tool' || node.kind === 'thinking' || node.kind === 'waiting';
}

export function groupChat(chat: ChatNode[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let run: ChatNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) rows.push({ key: run[0].key, node: run[0] });
    else rows.push({ key: `g-${run[0].key}`, group: run });
    run = [];
  };
  for (const node of chat) {
    if (node.kind === 'tool' && isHiddenWorkbenchTool(node.toolName)) continue;
    if (isActionBar(node)) {
      run.push(node);
      continue;
    }
    flush();
    // A retry loop appends one failure marker per attempt, so five attempts
    // against the same broken provider used to print five byte-identical rows.
    // Same notice, back to back → one row carrying the count (see
    // `isSameNotice`: a different cause is different news and keeps its row).
    const prev = rows.at(-1);
    if (prev?.node && isSameNotice(prev.node, node)) {
      prev.repeat = (prev.repeat ?? 1) + 1;
      continue;
    }
    rows.push({ key: node.key, node });
  }
  flush();
  return rows;
}

/**
 * Hidden tools leave thinking bars adjacent. Each tool-call turn also mints
 * its own bar. Collapse a run of thinking into one: keep the latest text,
 * span startedAt..endedAt so the duration is the whole stretch.
 *
 * One hard bound from the timing contract: a bar whose duration is already
 * frozen (ended, not streaming) must never be merged with a still-streaming
 * one — the merged bar would inherit the frozen number and then KEEP GROWING
 * when the streaming side settles, i.e. a finished bar's duration changing
 * after the fact. Streaming merges with streaming, frozen with frozen.
 */
export function collapseAdjacentThinking(nodes: ChatNode[]): ChatNode[] {
  const out: ChatNode[] = [];
  for (const node of nodes) {
    const prev = out.at(-1);
    if (
      node.kind === 'thinking' &&
      prev?.kind === 'thinking' &&
      Boolean(node.streaming) === Boolean(prev.streaming)
    ) {
      out[out.length - 1] = {
        ...node,
        key: prev.key,
        startedAt: prev.startedAt ?? node.startedAt,
        endedAt: node.endedAt ?? prev.endedAt,
        streaming: node.streaming || prev.streaming,
      };
      continue;
    }
    out.push(node);
  }
  return out;
}

export function rowsForRender(chat: ChatNode[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const row of groupChat(chat)) {
    if (row.node && !isActionBar(row.node)) {
      rows.push(row);
      continue;
    }
    const group = collapseAdjacentThinking(row.group ?? [row.node!]);
    // One key for the row however many bars it comes to hold, so it stays one row
    // as a run streams in.
    const key = `a-${group[0].key}`;
    rows.push(group.length === 1 ? { key, node: group[0] } : { key, group });
  }
  return rows;
}

/** Send an answer to an `ask_user` question as a user message. */
export type ChatAnswerHandler = (text: string) => Promise<boolean>;

/**
 * The cancel caption. Centered and faint — the run stopped because the user
 * said so, so it is a receipt, not a warning: an icon, one clause, and a count
 * if a stop was repeated back to back.
 */
function RunBoundary({
  node,
  repeat,
  t,
}: {
  node: ChatNode;
  repeat: number;
  t: WorkbenchTranslator;
}) {
  const notice = presentSystemNotice(node, t);
  return (
    <div className={styles.boundary.row} data-testid="workbench-run-boundary">
      <span className={styles.boundary.inner}>
        <span className={styles.boundary.icon} aria-hidden="true">
          <CircleSlash2 size={11} />
        </span>
        <span>{notice.summary}</span>
        {repeat > 1 ? (
          <span
            className={styles.boundary.count}
            title={repeatTitle(repeat, t)}
            aria-label={repeatTitle(repeat, t)}
          >
            {repeatLabel(repeat)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function ChatNodeView({
  node,
  plan,
  onAnswer,
  onRevive,
  collapsedQuestion = false,
  questionPointer = 'below',
  repeat = 1,
  excludeCourseCards,
  t,
}: {
  node: ChatNode;
  /** Courses that get no card under this text (`courseCardExclusions`). */
  excludeCourseCards?: ReadonlySet<string>;
  plan: PlannedPage[];
  onAnswer?: ChatAnswerHandler;
  onRevive?: (freeText?: boolean) => void;
  collapsedQuestion?: boolean;
  questionPointer?: QuestionPointer;
  repeat?: number;
  t: WorkbenchTranslator;
}) {
  switch (node.kind) {
    case 'user':
      return (
        <UserBubble
          text={node.text}
          materials={node.materials}
          elementRefs={node.elementRefs}
          courseRefs={node.courseRefs}
          t={t}
        />
      );
    case 'system':
      return <SystemNode node={node} repeat={repeat} t={t} />;
    case 'question':
      // The agent is waiting on the user. Its own row, never inside an action
      // cluster: a question is not something the agent DID, it is a hand-over.
      return (
        <QuestionCard
          node={node}
          onAnswer={onAnswer}
          onRevive={onRevive}
          collapsed={collapsedQuestion}
          pointer={questionPointer}
          t={t}
        />
      );
    case 'boundary':
      return <RunBoundary node={node} repeat={repeat} t={t} />;
    case 'course':
      // The tail of one exchange (question → answer): the classrooms it
      // produced or was pointed at, one card each, the rest behind a `+N`. The
      // row carries that answer's own ordered set; an empty one is the legacy
      // unbound row and SessionCourseLink falls back to the session's own stage.
      return <SessionCourseLink stageIds={node.stageIds} />;
    default:
      // The agent's own words are a text stream, with no container at all.
      // Tool cards keep their frame precisely because they are NOT speech —
      // they are operations — and the distinction is carried by the strongest
      // visual difference the rail has: prose floats, actions are boxed.
      // Streaming is quiet: no caret anywhere (PR walkthrough).
      return (
        <div className="text-[var(--wb-text)]">
          <TextBlock
            text={node.text}
            streaming={node.streaming}
            excludeCourseCards={excludeCourseCards}
          />
        </div>
      );
  }
}

/**
 * Edit-and-resend on the timeline (#1317 prototype). Absent, the timeline is
 * exactly the linear one it always was.
 */
export interface TimelineBranch {
  segments: Readonly<Record<string, BranchSegment>>;
  forks: ReadonlyMap<string, BranchFork>;
  /** A branch request is on its way: every control waits for it. */
  disabled: boolean;
  /** Send `text` as a new version of user message `userSeq`; resolves whether it was accepted. */
  onEdit: (userSeq: number, text: string, node: ChatNode) => Promise<boolean>;
  onRegenerate: (userSeq: number) => void;
  onSwitchUser: (userSeq: number) => void;
  onSwitchReply: (userSeq: number, variant: number | 'orig') => void;
}

function segmentOfRow(row: ChatRow): string | undefined {
  return (row.node ?? row.group?.[0])?.segment;
}

export function ChatTimeline({
  chat,
  plan,
  onAnswer,
  dismissedQuestionKey,
  onReviveQuestion,
  takenOverQuestionKey,
  questionPointer = 'below',
  turnActive = false,
  branch,
  t = defaultWorkbenchTranslator,
}: {
  chat: ChatNode[];
  plan: PlannedPage[];
  /**
   * The host's send path, handed to question cards so a clicked option travels
   * the SAME route as a typed message (optimistic STOP state included) instead
   * of a private POST beside it.
   */
  onAnswer?: ChatAnswerHandler;
  /**
   * The question whose composer form the user waved off, if any. That card — and
   * only that card — grows the way back to the form; every other question row is
   * unaware the form exists.
   */
  dismissedQuestionKey?: string | null;
  /** Bring a dismissed question's form back; `freeText` opens it on its text row. */
  onReviveQuestion?: (freeText?: boolean) => void;
  /**
   * The question whose form currently owns the composer. That row collapses to a
   * one-line pointer at the form, so the question and its options are on the
   * screen exactly once (see `question-card.tsx`).
   */
  takenOverQuestionKey?: string | null;
  /** Where the form that took the question over sits. */
  questionPointer?: QuestionPointer;
  /** The agent is still working, between events or not. */
  turnActive?: boolean;
  /** Edit-and-resend controls (#1317 prototype). */
  branch?: TimelineBranch;
  t?: WorkbenchTranslator;
}) {
  const rows = rowsForRender(chat);
  const exclusions = useMemo(() => courseCardExclusions(chat), [chat]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const lastSegment = rows.length > 0 ? segmentOfRow(rows[rows.length - 1]!) : undefined;

  /** The bubble, or its editor, and the controls under it. */
  const userRow = (row: ChatRow, view: ReactNode): ReactNode => {
    const node = row.node!;
    const segment = branch && node.segment ? branch.segments[node.segment] : undefined;
    if (!branch || !segment || segment.kind !== 'user' || segment.userSeq === undefined)
      return view;
    const userSeq = segment.userSeq;
    const fork = branch.forks.get(segment.id);
    if (editingKey === node.key) {
      return (
        <UserBubbleEditor
          key={row.key}
          initialText={node.text}
          hasAttachments={Boolean(node.materials?.length)}
          onCancel={() => setEditingKey(null)}
          onSubmit={async (text) => {
            const accepted = await branch.onEdit(userSeq, text, node);
            if (accepted) setEditingKey(null);
            return accepted;
          }}
          t={t}
        />
      );
    }
    return (
      <div key={row.key} className="flex flex-col gap-0.5">
        {view}
        <UserTurnControls
          fork={fork}
          // The opening prompt starts the session; the prototype edits follow-ups only.
          // A run still writing is no reason to hide it: the request stops the run first.
          editable={userSeq > 0}
          disabled={branch.disabled}
          onEdit={() => setEditingKey(node.key)}
          onSelect={(index) => {
            const target = fork?.siblings[index]?.userSeq;
            if (target !== undefined) branch.onSwitchUser(target);
          }}
          t={t}
        />
      </div>
    );
  };

  /** The controls closing one reply: switch between its versions, regenerate it. */
  const replyControls = (segmentId: string): ReactNode => {
    if (!branch) return null;
    const segment = branch.segments[segmentId];
    if (segment?.kind !== 'reply' || !segment.parent) return null;
    const userSeq = branch.segments[segment.parent]?.userSeq;
    if (userSeq === undefined) return null;
    const live = turnActive && segmentId === lastSegment;
    if (live) return null;
    const fork = branch.forks.get(segmentId);
    return (
      <ReplyTurnControls
        key={`branch-${segmentId}`}
        fork={fork}
        canRegenerate
        disabled={branch.disabled}
        onRegenerate={() => branch.onRegenerate(userSeq)}
        onSelect={(index) => {
          const variant = fork?.siblings[index]?.variant;
          if (variant !== undefined) branch.onSwitchReply(userSeq, variant);
        }}
        t={t}
      />
    );
  };

  const rendered: ReactNode[] = [];
  rows.forEach((row, index) => {
    rendered.push(renderRow(row, index));
    const segmentId = segmentOfRow(row);
    const nextSegment = index + 1 < rows.length ? segmentOfRow(rows[index + 1]!) : undefined;
    if (segmentId && segmentId !== nextSegment) rendered.push(replyControls(segmentId));
  });

  function renderRow(row: ChatRow, index: number): ReactNode {
    if (row.group || isActionBar(row.node!)) {
      return (
        <ActionCluster
          key={row.key}
          nodes={row.group ?? [row.node!]}
          plan={plan}
          ongoing={turnActive && index === rows.length - 1}
          t={t}
        />
      );
    }
    const view = (
      <ChatNodeView
        key={row.key}
        node={row.node!}
        plan={plan}
        repeat={row.repeat}
        excludeCourseCards={exclusions.get(row.node!.key)}
        t={t}
        onAnswer={onAnswer}
        collapsedQuestion={Boolean(takenOverQuestionKey) && row.node!.key === takenOverQuestionKey}
        questionPointer={questionPointer}
        onRevive={
          row.node!.key === dismissedQuestionKey && onReviveQuestion ? onReviveQuestion : undefined
        }
      />
    );
    return row.node!.kind === 'user' ? userRow(row, view) : view;
  }

  return <div className={styles.timeline.root}>{rendered}</div>;
}
