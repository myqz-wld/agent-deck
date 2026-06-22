import { lazy, Suspense, type JSX } from 'react';
import type { DiffPayload } from '@shared/types';
import { reconstructUnifiedDiffSnapshots } from '@shared/unified-diff';
import { useDiffExpanded } from '../ExpandedContext';

// Monaco 体积大，懒加载
const DiffEditor = lazy(async () => {
  const { configureLocalMonaco } = await import('@renderer/lib/monaco-local');
  configureLocalMonaco();
  const mod = await import('@monaco-editor/react');
  return { default: mod.DiffEditor };
});

interface Props {
  payload: DiffPayload<string | null>;
}

export function TextDiffRenderer({ payload }: Props): JSX.Element {
  const expanded = useDiffExpanded();
  const language = resolveLanguage(payload);
  // REVIEW_52 C1：部分来源 emit file-changed before:null after:null（Codex app-server 不提供
  // before/after 快照，但可能在 metadata.diff 带 unified diff）。有 unified diff 时先还原成
  // before/after 片段并复用 Monaco DiffEditor；解析不了时再显示 patch 原文兜底。
  const isNewFile = payload.before == null && payload.after != null;
  const isDeletedFile = payload.before != null && payload.after == null;
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
    const wholeFileToneFromDiff = unifiedDiff ? inferUnifiedDiffWholeFileTone(unifiedDiff) : null;
    const reconstructed = unifiedDiff ? reconstructUnifiedDiffSnapshots(unifiedDiff) : null;
    const reconstructedTone = reconstructed
      ? wholeFileToneFromChange(changeKind) ?? wholeFileToneFromDiff ?? inferWholeFileTone(reconstructed.before, reconstructed.after)
      : null;
    return (
      <div className="flex h-full flex-col gap-2">
        {!expanded && (
          <DiffHeader
            filePath={payload.filePath}
            isNewFile={false}
            isDeletedFile={false}
            changeKind={isCodex ? changeKind : null}
            patchStatus={isCodex ? patchStatus : null}
          />
        )}
        {reconstructed && reconstructedTone ? (
          <WholeFileDiffView
            tone={reconstructedTone}
            content={reconstructedTone === 'added' ? reconstructed.after : reconstructed.before}
          />
        ) : reconstructed ? (
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
  const wholeFileTone = inferWholeFileTone(payload.before, payload.after);
  return (
    <div className="flex h-full flex-col gap-1.5">
      {!expanded && (
        <DiffHeader
          filePath={payload.filePath}
          isNewFile={isNewFile}
          isDeletedFile={isDeletedFile}
        />
      )}
      {wholeFileTone ? (
        <WholeFileDiffView
          tone={wholeFileTone}
          content={wholeFileTone === 'added' ? after : before}
        />
      ) : (
        <MonacoDiffView before={before} after={after} language={language} />
      )}
    </div>
  );
}

function DiffHeader({
  filePath,
  isNewFile,
  isDeletedFile,
  changeKind,
  patchStatus,
}: {
  filePath: string;
  isNewFile: boolean;
  isDeletedFile?: boolean;
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
      {isDeletedFile && (
        <span className="rounded bg-status-error/20 px-1.5 py-0.5 text-[9px] text-status-error">
          删除
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

type WholeFileTone = 'added' | 'deleted';

function WholeFileDiffView({
  tone,
  content,
}: {
  tone: WholeFileTone;
  content: string;
}): JSX.Element {
  const lines = splitDisplayLines(content);
  const isAdded = tone === 'added';
  const styles = isAdded
    ? {
        container: 'border-status-working/35 bg-status-working/10',
        row: 'bg-status-working/[0.08]',
        marker: 'text-status-working',
      }
    : {
        container: 'border-status-error/35 bg-status-error/10',
        row: 'bg-status-error/[0.08]',
        marker: 'text-status-error',
      };
  return (
    <div
      className={`min-h-[260px] flex-1 overflow-auto rounded-md border ${styles.container}`}
      data-testid="full-file-diff"
      data-change-kind={tone}
    >
      <div className="font-mono text-[11px] leading-5 text-deck-text">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`grid grid-cols-[3rem_1.5rem_minmax(0,1fr)] gap-2 px-3 ${styles.row}`}
          >
            <span className="select-none text-right tabular-nums text-deck-muted/50">
              {content === '' ? '' : index + 1}
            </span>
            <span className={`select-none ${styles.marker}`}>{isAdded ? '+' : '-'}</span>
            <span className="whitespace-pre-wrap break-words">{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function splitDisplayLines(content: string): string[] {
  if (content === '') return [''];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function inferWholeFileTone(
  before: string | null,
  after: string | null,
): WholeFileTone | null {
  if (before == null && after != null) return 'added';
  if (before != null && after == null) return 'deleted';
  if (before === '' && after !== '') return 'added';
  if (before !== '' && after === '') return 'deleted';
  return null;
}

function wholeFileToneFromChange(changeKind: string | null): WholeFileTone | null {
  if (changeKind === 'add' || changeKind === 'create') return 'added';
  if (changeKind === 'delete' || changeKind === 'remove') return 'deleted';
  return null;
}

function inferUnifiedDiffWholeFileTone(diff: string): WholeFileTone | null {
  if (/^(new file mode |--- \/dev\/null$)/m.test(diff)) return 'added';
  if (/^(deleted file mode |\+\+\+ \/dev\/null$)/m.test(diff)) return 'deleted';
  return null;
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

export { reconstructUnifiedDiffSnapshots };

function resolveLanguage(payload: DiffPayload<string | null>): string {
  const language = payload.metadata?.language;
  if (typeof language === 'string' && language.trim()) return language.trim();
  return guessLanguageByPath(payload.filePath);
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
