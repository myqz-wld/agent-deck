import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';
import type { DiffOnMount } from '@monaco-editor/react';
import { useDiffLoadingFallback } from '../LoadingContext';

const DiffEditor = lazy(async () => {
  const { configureLocalMonaco } = await import('@renderer/lib/monaco-local');
  configureLocalMonaco();
  const mod = await import('@monaco-editor/react');
  return { default: mod.DiffEditor };
});

interface Props { before: string; after: string; language: string }

export function MonacoDiffView(props: Props): JSX.Element {
  const version = useRef({ ...props, number: 0 });
  if (version.current.before !== props.before || version.current.after !== props.after ||
      version.current.language !== props.language) {
    version.current = { ...props, number: version.current.number + 1 };
  }
  return <MonacoDiffModel key={version.current.number} {...props} />;
}

function MonacoDiffModel({ before, after, language }: Props): JSX.Element {
  const [ready, setReady] = useState(false);
  const loading = useDiffLoadingFallback(!ready, useId());
  const active = useRef(true);
  const frame = useRef<number | null>(null);
  const subscription = useRef<{ dispose(): void } | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      subscription.current?.dispose();
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, []);
  const onMount = useCallback<DiffOnMount>((editor) => {
    if (!active.current) return;
    let scheduled = false;
    const reveal = (): void => {
      if (scheduled || !active.current) return;
      scheduled = true;
      subscription.current?.dispose();
      // Layout the computed diff while hidden, then reveal it after the first settled frame.
      frame.current = window.requestAnimationFrame(() => {
        if (!active.current) return;
        editor.layout();
        frame.current = window.requestAnimationFrame(() => {
          if (active.current) setReady(true);
        });
      });
    };
    subscription.current = editor.onDidUpdateDiff(reveal);
    if (editor.getLineChanges() !== null) reveal();
  }, []);

  return (
    <div className="relative min-h-[260px] min-w-0 flex-1 overflow-hidden rounded-md border border-deck-border"
      aria-busy={!ready} data-testid="monaco-diff-surface">
      {loading && <div role="status" className="absolute inset-0 flex items-center justify-center text-[11px] text-deck-muted">
        加载改动…
      </div>}
      <div className="absolute inset-0" style={{ visibility: ready ? 'visible' : 'hidden' }} aria-hidden={!ready}>
        <Suspense fallback={null}>
          <DiffEditor
            height="100%" language={language} theme="vs-dark" original={before} modified={after}
            loading={null} onMount={onMount}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 11,
              scrollBeyondLastLine: false, padding: { bottom: 16 }, automaticLayout: true, renderOverviewRuler: false }}
          />
        </Suspense>
      </div>
    </div>
  );
}
