import { lazy, Suspense, type JSX } from 'react';
import type { DiffPayload } from '@shared/types';

// Monaco 体积大，懒加载
const DiffEditor = lazy(async () => {
  const mod = await import('@monaco-editor/react');
  return { default: mod.DiffEditor };
});

interface Props {
  payload: DiffPayload<string | null>;
}

export function TextDiffRenderer({ payload }: Props): JSX.Element {
  const language = guessLanguageByPath(payload.filePath);
  // REVIEW_52 C1：部分来源 emit file-changed before:null after:null（Codex app-server 不提供
  // before/after 快照，但可能在 metadata.diff 带 unified diff）。有 unified diff 时先还原成
  // before/after 片段并复用 Monaco DiffEditor；解析不了时再显示 patch 原文兜底。
  const isNewFile = payload.before == null && payload.after != null;
  const isMetaOnly = payload.before == null && payload.after == null;

  if (isMetaOnly) {
    // F5 修法（reviewer-claude HIGH-4）：按 metadata.source 分支，避免硬读 codex 字段名
    // 在 claude Write content=null 等罕见 payload 上显「changeKind: undefined」迷惑信息。
    const md = (payload.metadata ?? {}) as {
      source?: string;
      changeKind?: unknown;
      patchStatus?: unknown;
      diff?: unknown;
    };
    const isCodex = md.source === 'codex';
    const changeKind = normalizeCodexChangeKind(md.changeKind);
    const patchStatus = typeof md.patchStatus === 'string' ? md.patchStatus : null;
    const unifiedDiff = normalizeUnifiedDiffMetadata(md.diff);
    const reconstructed = unifiedDiff ? reconstructUnifiedDiffSnapshots(unifiedDiff) : null;
    return (
      <div className="flex h-full flex-col gap-2">
        <DiffHeader
          filePath={payload.filePath}
          isNewFile={false}
          changeKind={isCodex ? changeKind : null}
          patchStatus={isCodex ? patchStatus : null}
        />
        {reconstructed ? (
          <MonacoDiffView
            before={reconstructed.before}
            after={reconstructed.after}
            language={language}
          />
        ) : unifiedDiff ? (
          <div className="min-h-[260px] flex-1 overflow-auto rounded-md border border-deck-border bg-[#0f1218]">
            <pre className="m-0 p-3 font-mono text-[11px] leading-5 text-deck-text">
              {unifiedDiff}
            </pre>
          </div>
        ) : (
          <div className="rounded-md border border-deck-border bg-white/[0.02] p-3 text-[11px] text-deck-muted/85">
            {isCodex ? (
              <>
                Codex 未提供可显示的差异内容。
                如需查看当前工作区差异，请直接打开文件，或在终端运行{' '}
                <code className="font-mono">git diff</code>。
              </>
            ) : (
              <>
                这次改动缺少可显示的差异内容，请直接打开文件查看。
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  const before = payload.before ?? '';
  const after = payload.after ?? '';
  return (
    <div className="flex h-full flex-col gap-1.5">
      <DiffHeader filePath={payload.filePath} isNewFile={isNewFile} />
      <MonacoDiffView before={before} after={after} language={language} />
    </div>
  );
}

function DiffHeader({
  filePath,
  isNewFile,
  changeKind,
  patchStatus,
}: {
  filePath: string;
  isNewFile: boolean;
  changeKind?: string | null;
  patchStatus?: string | null;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-deck-muted/70">📄</span>
      <span className="truncate font-mono text-[11px]">{filePath}</span>
      {isNewFile && (
        <span className="rounded bg-status-working/20 px-1.5 py-0.5 text-[9px] text-status-working">
          新增
        </span>
      )}
      {changeKind && (
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${
            changeKind === 'add'
              ? 'bg-status-working/20 text-status-working'
              : changeKind === 'delete'
                ? 'bg-status-error/20 text-status-error'
                : 'bg-white/10 text-deck-muted'
          }`}
        >
          {changeKind}
        </span>
      )}
      {patchStatus && patchStatus !== 'completed' && (
        <span className="rounded bg-status-error/20 px-1.5 py-0.5 text-[9px] uppercase text-status-error">
          {patchStatus}
        </span>
      )}
    </div>
  );
}

function MonacoDiffView({
  before,
  after,
  language,
}: {
  before: string;
  after: string;
  language: string;
}): JSX.Element {
  return (
    <div className="min-h-[260px] flex-1 overflow-hidden rounded-md border border-deck-border">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">
            加载差异视图…
          </div>
        }
      >
        <DiffEditor
          height="100%"
          language={language}
          theme="vs-dark"
          original={before}
          modified={after}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            fontSize: 11,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderOverviewRuler: false,
          }}
        />
      </Suspense>
    </div>
  );
}

export function normalizeCodexChangeKind(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' && type ? type : null;
  }
  return null;
}

export function normalizeUnifiedDiffMetadata(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}

export function reconstructUnifiedDiffSnapshots(
  unifiedDiff: string,
): { before: string; after: string } | null {
  const before: string[] = [];
  const after: string[] = [];
  let inHunk = false;
  let sawHunkLine = false;
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n');

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (sawHunkLine) {
        before.push('...');
        after.push('...');
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;

    const marker = line[0];
    const body = line.slice(1);
    if (marker === ' ') {
      before.push(body);
      after.push(body);
      sawHunkLine = true;
    } else if (marker === '-') {
      before.push(body);
      sawHunkLine = true;
    } else if (marker === '+') {
      after.push(body);
      sawHunkLine = true;
    } else if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      inHunk = false;
    }
  }

  if (!sawHunkLine) return null;
  return {
    before: before.join('\n'),
    after: after.join('\n'),
  };
}

function guessLanguageByPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'hpp':
      return 'cpp';
    default:
      return 'plaintext';
  }
}
