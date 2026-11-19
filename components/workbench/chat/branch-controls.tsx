'use client';

/**
 * Edit-and-resend controls (#1317 prototype).
 *
 * Under a user bubble: the version switcher of an edited message and the edit
 * button. Under a reply: the switcher of a regenerated reply, the regenerate
 * button. A stopped reply already ends in the run's own "stopped" caption.
 * A switch moves the course with the conversation, which the switcher's title
 * says.
 *
 * Kept in the metadata register of the rail -- 11px, muted, no frame -- so a
 * conversation that never branches looks exactly as it did.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Pencil, RotateCcw } from 'lucide-react';
import type { WorkbenchTranslator } from '@/lib/i18n/workbench';
import type { BranchFork } from '@/lib/workbench/branch-fold';
import { cn } from '@/lib/utils/cn';

const styles = {
  row: 'flex items-center gap-1 text-[11px] leading-4 text-[var(--wb-text-faint)]',
  button:
    'inline-flex size-6 cursor-pointer items-center justify-center rounded-[var(--wb-radius-sm)] border-0 bg-transparent p-0 text-[var(--wb-text-faint)] transition-colors duration-[var(--wb-duration-base)] hover:bg-[var(--wb-surface-sunken)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent motion-reduce:transition-none',
  position: 'min-w-[2.25rem] text-center tabular-nums',
  editor:
    'flex w-full max-w-[85%] flex-col gap-2 rounded-2xl rounded-br-md border border-violet-300/70 bg-white px-3 py-2.5 dark:border-violet-400/30 dark:bg-white/5',
  textarea:
    'min-h-[72px] w-full resize-y border-0 bg-transparent p-0 text-[length:var(--wb-text-base)] leading-relaxed text-[var(--wb-text)] outline-none',
  editorFooter: 'flex items-center justify-between gap-2',
  editorNote: 'text-[11px] leading-4 text-[var(--wb-text-muted)]',
  editorActions: 'ml-auto flex items-center gap-1.5',
  textButton:
    'inline-flex h-7 cursor-pointer items-center rounded-[var(--wb-radius-sm)] border border-[var(--wb-line)] bg-transparent px-2.5 text-[12px] text-[var(--wb-text)] hover:bg-[var(--wb-surface-sunken)] disabled:cursor-default disabled:opacity-50',
  primaryButton:
    'inline-flex h-7 cursor-pointer items-center rounded-[var(--wb-radius-sm)] border-0 bg-violet-600 px-2.5 text-[12px] text-white hover:bg-violet-700 disabled:cursor-default disabled:opacity-50',
};

function VersionSwitcher({
  fork,
  onSelect,
  disabled,
  t,
}: {
  fork: BranchFork;
  onSelect: (index: number) => void;
  disabled: boolean;
  t: WorkbenchTranslator;
}) {
  return (
    <span
      className="inline-flex items-center"
      title={t('workbench.chat.branchCourseFollows')}
      data-testid="branch-switcher"
    >
      <button
        type="button"
        className={styles.button}
        aria-label={t('workbench.chat.branchPrevious')}
        disabled={disabled || fork.index === 0}
        onClick={() => onSelect(fork.index - 1)}
      >
        <ChevronLeft size={13} />
      </button>
      <span className={styles.position}>
        {fork.index + 1} / {fork.count}
      </span>
      <button
        type="button"
        className={styles.button}
        aria-label={t('workbench.chat.branchNext')}
        disabled={disabled || fork.index === fork.count - 1}
        onClick={() => onSelect(fork.index + 1)}
      >
        <ChevronRight size={13} />
      </button>
    </span>
  );
}

export function UserTurnControls({
  fork,
  editable,
  disabled,
  onEdit,
  onSelect,
  t,
}: {
  fork?: BranchFork;
  editable: boolean;
  disabled: boolean;
  onEdit: () => void;
  onSelect: (index: number) => void;
  t: WorkbenchTranslator;
}) {
  if (!fork && !editable) return null;
  return (
    <div className={cn(styles.row, 'justify-end')} data-testid="branch-user-controls">
      {fork ? <VersionSwitcher fork={fork} onSelect={onSelect} disabled={disabled} t={t} /> : null}
      {editable ? (
        <button
          type="button"
          className={styles.button}
          aria-label={t('workbench.chat.branchEdit')}
          title={t('workbench.chat.branchEdit')}
          disabled={disabled}
          onClick={onEdit}
        >
          <Pencil size={12} />
        </button>
      ) : null}
    </div>
  );
}

export function ReplyTurnControls({
  fork,
  canRegenerate,
  disabled,
  onRegenerate,
  onSelect,
  t,
}: {
  fork?: BranchFork;
  canRegenerate: boolean;
  disabled: boolean;
  onRegenerate: () => void;
  onSelect: (index: number) => void;
  t: WorkbenchTranslator;
}) {
  if (!fork && !canRegenerate) return null;
  return (
    <div className={styles.row} data-testid="branch-reply-controls">
      {fork ? <VersionSwitcher fork={fork} onSelect={onSelect} disabled={disabled} t={t} /> : null}
      {canRegenerate ? (
        <button
          type="button"
          className={styles.button}
          aria-label={t('workbench.chat.branchRegenerate')}
          title={t('workbench.chat.branchRegenerate')}
          disabled={disabled}
          onClick={onRegenerate}
        >
          <RotateCcw size={12} />
        </button>
      ) : null}
    </div>
  );
}

/** The bubble, turned into an editor of its own text. */
export function UserBubbleEditor({
  initialText,
  hasAttachments,
  onCancel,
  onSubmit,
  t,
}: {
  initialText: string;
  hasAttachments: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<boolean>;
  t: WorkbenchTranslator;
}) {
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const trimmed = text.trim();
  const submit = async () => {
    if (!trimmed || sending) return;
    setSending(true);
    const accepted = await onSubmit(trimmed);
    // An accepted edit unmounts this editor; a refused one keeps the text.
    if (!accepted) setSending(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <div className="flex justify-end" data-testid="branch-user-editor">
      <div className={styles.editor}>
        <textarea
          ref={area}
          className={styles.textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={t('workbench.chat.branchEdit')}
        />
        <div className={styles.editorFooter}>
          {hasAttachments ? (
            <span className={styles.editorNote}>
              {t('workbench.chat.branchEditAttachmentsKept')}
            </span>
          ) : null}
          <span className={styles.editorActions}>
            <button type="button" className={styles.textButton} onClick={onCancel}>
              {t('workbench.chat.branchEditCancel')}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!trimmed || sending || trimmed === initialText.trim()}
              onClick={() => void submit()}
            >
              {t('workbench.chat.branchEditSend')}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
