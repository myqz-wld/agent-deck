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
  // REVIEW_52 C1：codex emit file-changed before:null after:null（codex SDK 不传 diff
  // 文本，仅记录路径与 changeKind / patchStatus 元数据）。旧版直接 `before ?? '' / after ?? ''`
  // 渲染空 Monaco editor → 用户看到空白「改动页无效」（reviewer 异构对抗 F5 共识 + 用户铁证）。
  // 新增 isMetaOnly 分支：两端都 null 时不挂 Monaco，改显元数据卡片。
  const isNewFile = payload.before == null && payload.after != null;
  const isMetaOnly = payload.before == null && payload.after == null;

  if (isMetaOnly) {
    // F5 修法（reviewer-claude HIGH-4）：按 metadata.source 分支，避免硬读 codex 字段名
    // 在 claude Write content=null 等罕见 payload 上显「changeKind: undefined」迷惑信息。
    const md = (payload.metadata ?? {}) as {
      source?: string;
      changeKind?: string;
      patchStatus?: string;
    };
    const isCodex = md.source === 'codex';
    return (
      <div className="flex h-full flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-deck-muted/70">📄</span>
          <span className="truncate font-mono text-[11px]">{payload.filePath}</span>
          {isCodex && md.changeKind && (
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${
                md.changeKind === 'add'
                  ? 'bg-status-working/20 text-status-working'
                  : md.changeKind === 'delete'
                    ? 'bg-status-error/20 text-status-error'
                    : 'bg-white/10 text-deck-muted'
              }`}
            >
              {md.changeKind}
            </span>
          )}
          {isCodex && md.patchStatus && md.patchStatus !== 'completed' && (
            <span className="rounded bg-status-error/20 px-1.5 py-0.5 text-[9px] uppercase text-status-error">
              {md.patchStatus}
            </span>
          )}
        </div>
        <div className="rounded-md border border-deck-border bg-white/[0.02] p-3 text-[11px] text-deck-muted/85">
          {isCodex ? (
            <>
              Codex 仅记录文件改动路径与类型，不提供 diff 文本内容。
              如需查看实际差异，请直接打开文件或在终端跑 <code className="font-mono">git diff</code>。
            </>
          ) : (
            <>
              文件信息缺失（source: <code className="font-mono">{String(md.source ?? 'unknown')}</code>）。
              before/after 均为 null，无法渲染 diff。
            </>
          )}
        </div>
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
            NEW
          </span>
        )}
      </div>
      <div className="min-h-[260px] flex-1 overflow-hidden rounded-md border border-deck-border">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">
              加载 Monaco…
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
