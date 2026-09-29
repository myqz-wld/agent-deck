import type { JSX } from 'react';
import type { DiffPayload } from '@shared/types';
import { normalizeTextDiff, type TextChangeKind } from '@shared/file-change-diff';
import { useDiffExpanded } from '../ExpandedContext';
import { FileTextIcon } from '../../icons';
import { MonacoDiffView } from './MonacoDiffView';

interface Props {
  payload: DiffPayload<string | null>;
}

export function TextDiffRenderer({ payload }: Props): JSX.Element {
  const expanded = useDiffExpanded();
  const language = resolveLanguage(payload);
  const model = normalizeTextDiff(payload);
  const hasContent = model.before !== null || model.after !== null;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-1.5">
      {!expanded && <DiffHeader filePath={payload.filePath} change={model.change} status={payload.metadata?.patchStatus} />}
      {hasContent && model.change !== 'modified' ? (
        <WholeFileDiffView
          tone={model.change}
          content={(model.change === 'added' ? model.after : model.before) ?? ''}
        />
      ) : hasContent ? (
        <MonacoDiffView before={model.before ?? ''} after={model.after ?? ''} language={language} />
      ) : model.patch ? (
        <div className="min-h-[260px] min-w-0 flex-1 overflow-auto rounded-md border border-deck-border bg-[#0f1218]">
          <pre className="m-0 px-3 pt-3 pb-6 font-mono text-[11px] leading-5 text-deck-text">{model.patch}</pre>
        </div>
      ) : (
        <div className="rounded-md border border-deck-border bg-white/[0.02] p-3 text-[11px] text-deck-muted/85">
          这次改动未记录可显示的内容。
        </div>
      )}
    </div>
  );
}

function DiffHeader({ filePath, change, status }: {
  filePath: string;
  change: TextChangeKind;
  status?: unknown;
}): JSX.Element {
  const tone = change === 'added' ? 'bg-status-working/20 text-status-working'
    : change === 'deleted' ? 'bg-status-error/20 text-status-error' : 'bg-white/10 text-deck-muted';
  return (
    <div className="flex min-w-0 items-center gap-2 text-[11px]">
      <FileTextIcon className="h-3.5 w-3.5 shrink-0 text-deck-muted/70" />
      <span className="truncate font-mono" title={filePath}>{filePath}</span>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${tone}`}>
        {{ added: '新增', deleted: '删除', modified: '修改' }[change]}
      </span>
      {typeof status === 'string' && status && status !== 'completed' && (
        <span className="shrink-0 rounded bg-status-error/20 px-1.5 py-0.5 text-[9px] text-status-error">{status}</span>
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
      className={`min-h-[260px] min-w-0 flex-1 overflow-auto rounded-md border ${styles.container}`}
      data-testid="full-file-diff"
      data-change-kind={tone}
    >
      <div className="pb-5 font-mono text-[11px] leading-5 text-deck-text">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`grid grid-cols-[3rem_1.5rem_minmax(0,1fr)] gap-2 px-3 ${styles.row}`}
          >
            <span className="select-none text-right tabular-nums text-deck-muted/50">
              {content === '' ? '' : index + 1}
            </span>
            <span className={`select-none ${styles.marker}`}>{isAdded ? '+' : '-'}</span>
            <span className="whitespace-pre-wrap break-words">{content === '' ? '（空文件）' : line || ' '}</span>
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

export function normalizeUnifiedDiffMetadata(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}

export { reconstructUnifiedDiffSnapshots } from '@shared/unified-diff';

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
