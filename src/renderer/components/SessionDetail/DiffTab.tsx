import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DiffPayload, FileChangeRecord, FileFinalDiffResult } from '@shared/types';
import { DiffViewer } from '../diff/DiffViewer';
import { ChangeTimeline } from './ChangeTimeline';
import type { FileChangeGroup } from './helpers';

type DiffMode = 'single' | 'final';
type FileGroup = FileChangeGroup<FileChangeRecord>;

interface Props {
  sessionId: string;
  changes: FileChangeRecord[] | null;
  diffError: string | null;
  fileGroups: FileGroup[];
  selectedFilePath: string | null;
  selectedGroup: FileGroup | null;
  selectedChangeId: number | null;
  diffMode: DiffMode;
  finalDiffLoading: boolean;
  finalDiff: FileFinalDiffResult | null;
  diffPayload: DiffPayload | null;
  finalDiffPayload: DiffPayload | null;
  onSelectFile: (group: FileGroup) => void;
  onSelectChange: (id: number) => void;
  onDiffModeChange: (mode: DiffMode) => void;
}

export function DiffTab({
  sessionId,
  changes,
  diffError,
  fileGroups,
  selectedFilePath,
  selectedGroup,
  selectedChangeId,
  diffMode,
  finalDiffLoading,
  finalDiff,
  diffPayload,
  finalDiffPayload,
  onSelectFile,
  onSelectChange,
  onDiffModeChange,
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const selectedFileIndex = useMemo(
    () => fileGroups.findIndex((g) => g.filePath === selectedFilePath),
    [fileGroups, selectedFilePath],
  );
  const activePayload = diffMode === 'final' ? finalDiffPayload : diffPayload;

  const selectByOffset = (offset: number): void => {
    if (selectedFileIndex < 0 || fileGroups.length === 0) return;
    const next = fileGroups[selectedFileIndex + offset];
    if (next) onSelectFile(next);
  };

  const renderFileNav = (showExpand: boolean): JSX.Element => (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => selectByOffset(-1)}
        disabled={selectedFileIndex <= 0}
        className="rounded bg-white/[0.03] px-2 py-1 text-[10px] text-deck-muted hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
        title="切换到上一个文件"
      >
        上一文件
      </button>
      <button
        type="button"
        onClick={() => selectByOffset(1)}
        disabled={selectedFileIndex < 0 || selectedFileIndex >= fileGroups.length - 1}
        className="rounded bg-white/[0.03] px-2 py-1 text-[10px] text-deck-muted hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
        title="切换到下一个文件"
      >
        下一文件
      </button>
      {showExpand && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          disabled={!activePayload}
          className="rounded bg-white/[0.03] px-2 py-1 text-[10px] text-deck-muted hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
          title="放大改动视图"
        >
          放大
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-2">
      {changes === null ? (
        diffError ? (
          <div className="text-[11px] text-status-waiting">加载改动失败：{diffError}</div>
        ) : (
          <div className="text-[11px] text-deck-muted">加载中…</div>
        )
      ) : changes.length === 0 ? (
        <div className="text-[11px] text-deck-muted">本会话暂无文件改动</div>
      ) : (
        <>
          {diffError && (
            <div className="shrink-0 text-[10px] text-status-waiting/80">
              刷新改动失败（显示的是上次结果）：{diffError}
            </div>
          )}
          <div className="flex shrink-0 flex-wrap gap-1">
            {fileGroups.map((g) => (
              <button
                key={g.filePath}
                type="button"
                onClick={() => onSelectFile(g)}
                className={`relative max-w-[160px] truncate rounded px-2 py-1 text-[10px] font-mono ${
                  selectedFilePath === g.filePath
                    ? 'bg-white/15 text-deck-text'
                    : 'bg-white/[0.03] text-deck-muted hover:bg-white/[0.08]'
                }`}
                title={`${g.filePath}（${g.items.length} 次改动）`}
              >
                {g.filePath.split('/').pop()}
                {g.items.length > 1 && (
                  <span className="ml-1 rounded bg-white/15 px-1 text-[9px] text-deck-text/80">
                    {g.items.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {selectedGroup && (
            <div className="flex shrink-0 items-center gap-1">
              {(['single', 'final'] as DiffMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onDiffModeChange(mode)}
                  className={`rounded px-2 py-1 text-[10px] ${
                    diffMode === mode
                      ? 'bg-white/15 text-deck-text'
                      : 'bg-white/[0.03] text-deck-muted hover:bg-white/[0.08]'
                  }`}
                >
                  {mode === 'single' ? '单次改动' : '最终 diff'}
                </button>
              ))}
              <div className="ml-auto">{renderFileNav(true)}</div>
            </div>
          )}

          {diffMode === 'single' && selectedGroup && selectedGroup.items.length > 1 && (
            <ChangeTimeline
              items={selectedGroup.items}
              selectedId={selectedChangeId}
              onSelect={onSelectChange}
            />
          )}

          <div className="min-h-0 flex-1">
            {renderDiffBody({
              sessionId,
              diffMode,
              finalDiffLoading,
              finalDiff,
              diffPayload,
              finalDiffPayload,
            })}
          </div>
        </>
      )}

      {expanded &&
        createPortal(
          <ExpandedDiffOverlay
            filePath={activePayload?.filePath ?? selectedFilePath ?? ''}
            onClose={() => setExpanded(false)}
            fileNav={renderFileNav(false)}
          >
            {renderDiffBody({
              sessionId,
              diffMode,
              finalDiffLoading,
              finalDiff,
              diffPayload,
              finalDiffPayload,
              hideHeader: true,
            })}
          </ExpandedDiffOverlay>,
          document.getElementById('floating-frame-root') ?? document.body,
        )}
    </div>
  );
}

function renderDiffBody(args: {
  sessionId: string;
  diffMode: DiffMode;
  finalDiffLoading: boolean;
  finalDiff: FileFinalDiffResult | null;
  diffPayload: DiffPayload | null;
  finalDiffPayload: DiffPayload | null;
  hideHeader?: boolean;
}): JSX.Element | null {
  if (args.diffMode === 'final') {
    if (args.finalDiffLoading) {
      return <div className="text-[11px] text-deck-muted">加载最终 diff…</div>;
    }
    if (args.finalDiffPayload) {
      return (
        <DiffViewer
          payload={args.finalDiffPayload}
          sessionId={args.sessionId}
          expanded={args.hideHeader}
        />
      );
    }
    return (
      <div className="rounded-md border border-deck-border bg-white/[0.02] p-3 text-[11px] text-deck-muted/85">
        {args.finalDiff?.message ?? '暂无可显示的最终 diff'}
      </div>
    );
  }
  return args.diffPayload ? (
    <DiffViewer payload={args.diffPayload} sessionId={args.sessionId} expanded={args.hideHeader} />
  ) : null;
}

function ExpandedDiffOverlay({
  filePath,
  onClose,
  fileNav,
  children,
}: {
  filePath: string;
  onClose: () => void;
  fileNav: JSX.Element;
  children: ReactNode;
}): JSX.Element {
  const lastSlash = filePath.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
  const filePart = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="放大改动视图"
    >
      <div className="absolute inset-0 flex flex-col bg-[#141418]">
        <div className="flex shrink-0 items-center gap-2 border-b border-deck-border pl-[78px] pr-4 py-2">
          <div className="min-w-0 flex-1">
            {dirPart && (
              <div className="truncate font-mono text-[10px] leading-tight text-deck-muted">
                {dirPart}
              </div>
            )}
            <div className="truncate font-mono text-[12px] font-medium leading-tight text-deck-text">
              {filePart || '改动'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {fileNav}
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-white/[0.06] px-2 py-1 text-[11px] text-deck-muted hover:bg-white/[0.12]"
            >
              关闭
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 px-4 py-3">{children}</div>
      </div>
    </div>
  );
}
