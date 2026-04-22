import { useState, type JSX, type ReactNode } from 'react';
import type { DiffPayload, ImageSource } from '@shared/types';
import { useDiffSessionId } from '../SessionContext';
import { ImageBlobLoader } from './ImageBlobLoader';

interface Props {
  payload: DiffPayload<ImageSource | null>;
}

type Mode = 'side' | 'after-only' | 'slide';

/**
 * 图片 diff 渲染器（真实实现）。
 *
 * 设计：
 * - 通过 useDiffSessionId() 拿当前 sessionId，传给 ImageBlobLoader → 主进程白名单校验
 * - before/after 是 ImageSource（kind:'path' 现阶段唯一形态），不带图片二进制；ImageBlobLoader
 *   懒加载 dataURL。MCP server 清理快照后会显示「图片不可读」灰底兜底。
 * - 支持三种模式：side（左右并排，默认）/ after-only（仅看新图）/ slide（二期接 react-compare-slider）
 * - header 显示 filePath、NEW 标签（before == null = ImageWrite 新增场景）、prompt（来自 metadata）
 */
export function ImageDiffRenderer({ payload }: Props): JSX.Element {
  const sessionId = useDiffSessionId();
  const [mode, setMode] = useState<Mode>('side');
  const before = payload.before ?? null;
  const after = payload.after ?? null;
  const isWrite = before == null && after != null;
  const prompt =
    typeof payload.metadata?.prompt === 'string' ? (payload.metadata.prompt as string) : null;
  const editIndex =
    typeof payload.metadata?.editIndex === 'number' ? (payload.metadata.editIndex as number) : null;
  const total =
    typeof payload.metadata?.total === 'number' ? (payload.metadata.total as number) : null;

  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-deck-muted/70">🖼</span>
        <span className="truncate font-mono text-[11px]">{payload.filePath}</span>
        {isWrite && (
          <span className="rounded bg-status-working/20 px-1.5 py-0.5 text-[9px] text-status-working">
            NEW
          </span>
        )}
        {editIndex != null && total != null && total > 1 && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-deck-muted">
            #{editIndex + 1} / {total}
          </span>
        )}
        {prompt && (
          <span
            className="ml-1 truncate text-[10px] italic text-deck-muted"
            title={prompt}
          >
            “{prompt}”
          </span>
        )}
        <div className="ml-auto flex gap-1">
          {(['side', 'after-only', 'slide'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                mode === m
                  ? 'bg-white/15 text-deck-text'
                  : 'text-deck-muted hover:bg-white/5'
              }`}
            >
              {m === 'side' ? '并排' : m === 'after-only' ? '仅新图' : '滑动'}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-[260px] flex-1 overflow-hidden rounded-md border border-deck-border p-1">
        {mode === 'side' && (
          <div className="grid h-full grid-cols-2 gap-2">
            <Pane title="before" empty="(无)">
              {before ? <BlobImg sid={sessionId} src={before} /> : null}
            </Pane>
            <Pane title="after" empty="(无)">
              {after ? <BlobImg sid={sessionId} src={after} /> : null}
            </Pane>
          </div>
        )}
        {mode === 'after-only' && (
          <div className="flex h-full items-center justify-center">
            {after ? (
              <BlobImg sid={sessionId} src={after} />
            ) : (
              <span className="text-[10px] text-deck-muted">(无 after 图)</span>
            )}
          </div>
        )}
        {mode === 'slide' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-deck-muted">
            <div>滑动对比模式待实现（二期接 react-compare-slider）</div>
            <div className="text-[10px] opacity-70">先回退到「并排」查看 before / after</div>
          </div>
        )}
      </div>
    </div>
  );
}

function BlobImg({ sid, src }: { sid: string; src: ImageSource }): JSX.Element {
  return (
    <ImageBlobLoader sessionId={sid} source={src}>
      {({ loading, result }) => {
        if (loading) {
          return <div className="h-full w-full animate-pulse bg-white/[0.03]" />;
        }
        if (!result) return <div className="h-full w-full bg-white/[0.02]" />;
        if (!result.ok) {
          return (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-deck-muted">
              图片不可读：{result.reason}
              {result.detail ? ` · ${result.detail}` : ''}
            </div>
          );
        }
        return (
          <img
            src={result.dataUrl}
            alt={src.kind === 'path' ? src.path : 'image'}
            className="max-h-full max-w-full object-contain"
          />
        );
      }}
    </ImageBlobLoader>
  );
}

function Pane({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className="text-[9px] uppercase tracking-wider text-deck-muted">{title}</div>
      <div className="flex flex-1 items-center justify-center overflow-hidden rounded border border-deck-border bg-white/[0.02]">
        {children ?? <span className="text-[10px] text-deck-muted">{empty}</span>}
      </div>
    </div>
  );
}
