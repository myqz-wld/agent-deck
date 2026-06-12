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
  // before/after 快照，但可能在 metadata.diff 带 unified diff）。两端都 null 时不挂 Monaco
  // DiffEditor；有 unified diff 则显示 patch 内容，否则显示元数据兜底。
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
    return (
      <div className="flex h-full flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-deck-muted/70">📄</span>
          <span className="truncate font-mono text-[11px]">{payload.filePath}</span>
          {isCodex && changeKind && (
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
          {isCodex && patchStatus && patchStatus !== 'completed' && (
            <span className="rounded bg-status-error/20 px-1.5 py-0.5 text-[9px] uppercase text-status-error">
              {patchStatus}
            </span>
          )}
        </div>
        {unifiedDiff ? (
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
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-deck-muted/70">📄</span>
        <span className="truncate font-mono text-[11px]">{payload.filePath}</span>
        {isNewFile && (
          <span className="rounded bg-status-working/20 px-1.5 py-0.5 text-[9px] text-status-working">
            新增
          </span>
        )}
      </div>
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
