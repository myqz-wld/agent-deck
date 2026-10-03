import { useEffect, useRef, type JSX } from 'react';
import type { DiffOnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { configureLocalMonaco } from '@renderer/lib/monaco-local';

interface Props {
  original: string;
  modified: string;
  language: string;
  options: monaco.editor.IStandaloneDiffEditorConstructionOptions;
  onMount: DiffOnMount;
}

/** Own one editor and its private models; detach the models before releasing any resource. */
export function MonacoDiffEditor({ original, modified, language, options, onMount }: Props): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    configureLocalMonaco();
    const models: monaco.editor.ITextModel[] = [];
    let editor: monaco.editor.IStandaloneDiffEditor | undefined;
    const dispose = (): void => {
      const current = editor;
      editor = undefined;
      try {
        if (current) {
          try { current.setModel(null); }
          finally { current.dispose(); }
        }
      } finally {
        for (const model of models.splice(0)) model.dispose();
      }
    };
    try {
      models.push(monaco.editor.createModel(original, language));
      models.push(monaco.editor.createModel(modified, language));
      editor = monaco.editor.createDiffEditor(container.current, options);
      editor.setModel({ original: models[0], modified: models[1] });
      monaco.editor.setTheme('vs-dark');
      onMount(editor, monaco);
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  }, [original, modified, language, options, onMount]);
  return <div ref={container} className="h-full w-full" />;
}
