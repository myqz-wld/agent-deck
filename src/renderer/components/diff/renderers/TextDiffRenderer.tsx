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
  const before = payload.before ?? '';
  const after = payload.after ?? '';
  const isNewFile = payload.before == null;

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
