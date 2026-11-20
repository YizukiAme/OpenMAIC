'use client';

import { useEffect, useState } from 'react';
import type { Scene } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { QuizScene } from '@/lib/standalone-player/scenes/QuizScene';
import { PblScene } from '@/lib/standalone-player/scenes/PblScene';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  STANDALONE_INTERACTIVE_SANDBOX,
  type StandalonePlayerStrings,
} from '@/lib/export/standalone-html/contract';

type SavedCourse = { stage: { name: string }; scenes: Scene[] };

export function BranchCoursePreview({
  url,
  initialSceneId,
  initialIndex,
}: {
  url: string;
  initialSceneId: string | null;
  initialIndex: number;
}) {
  const { t } = useI18n();
  const [course, setCourse] = useState<SavedCourse | null>();
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState<number>();
  const [openedAt] = useState({ id: initialSceneId, index: initialIndex });
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Course version unavailable');
        const saved: SavedCourse | null = await response.json();
        if (!controller.signal.aborted) setCourse(saved);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [url]);
  if (!course?.scenes.length)
    return (
      <p className="m-auto p-4 text-sm text-muted-foreground" role="status">
        {t(
          failed
            ? 'workbench.chat.branchFailed'
            : course === undefined
              ? 'workbench.common.loading'
              : 'workbench.chat.branchNoCourse',
        )}
      </p>
    );
  const at = course.scenes.findIndex((scene) => scene.id === openedAt.id);
  const index =
    page ?? (at >= 0 ? at : Math.min(Math.max(openedAt.index, 0), course.scenes.length - 1));
  const scene = course.scenes[index]!;
  const content = scene.content;
  const strings = Object.fromEntries(
    STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, t(`export.htmlPlayer.${key}`)]),
  ) as StandalonePlayerStrings;
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3 p-3" data-testid="branch-course-preview">
      <h2 className="text-sm font-semibold">{course.stage.name}</h2>
      <select
        aria-label={t('workbench.chat.branchPreview')}
        className="w-full truncate rounded-md border p-2"
        value={index}
        onChange={(event) => setPage(Number(event.target.value))}
      >
        {course.scenes.map((s, i) => (
          <option key={s.id} value={i}>
            {i + 1} / {course.scenes.length} · {s.title}
          </option>
        ))}
      </select>
      <div key={scene.id} className="relative flex min-h-0 flex-1 items-center">
        {content.type === 'slide' && (
          <div
            className="w-full"
            style={{ aspectRatio: 1 / (content.canvas.viewportRatio || 0.5625) }}
          >
            <SlideThumbnail
              slide={content.canvas}
              viewportRatio={content.canvas.viewportRatio || 0.5625}
            />
          </div>
        )}
        {content.type === 'quiz' && <QuizScene questions={content.questions} strings={strings} />}
        {content.type === 'pbl' && (
          <PblScene content={content} sceneTitle={scene.title} strings={strings} />
        )}
        {content.type === 'interactive' && (
          <iframe
            title={scene.title}
            className="size-full border-0"
            sandbox={STANDALONE_INTERACTIVE_SANDBOX}
            srcDoc={content.html}
            src={content.html ? undefined : content.url}
          />
        )}
      </div>
    </section>
  );
}
