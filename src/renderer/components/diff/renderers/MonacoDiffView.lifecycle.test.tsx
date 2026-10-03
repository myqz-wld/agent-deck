// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { MonacoDiffView } from './MonacoDiffView';
import { MonacoDiffEditor } from './MonacoDiffEditor';
import { ExpandedDiffOverlay } from '../ExpandedDiffOverlay';

const runtime = vi.hoisted(() => {
  interface Model { value: string; disposed: boolean; dispose(): void }
  interface Editor {
    model: { original: Model; modified: Model } | null;
    disposed: boolean;
    getModel(): Editor['model'];
    setModel(model: Editor['model']): void;
    dispose(): void;
    layout(): void;
    updateOptions(): void;
    getLineChanges(): [];
    onDidUpdateDiff(): { dispose(): void };
  }
  const models: Model[] = [];
  const editors: Editor[] = [];
  const violations: string[] = [];
  const monaco = {
    Uri: { parse: (path: string) => ({ path }) },
    editor: {
      getModel: () => undefined,
      setTheme: vi.fn(),
      createModel: vi.fn((value: string) => {
        const model: Model = {
          value, disposed: false,
          dispose() {
            if (editors.some((editor) => !editor.disposed
              && (editor.model?.original === model || editor.model?.modified === model))) {
              violations.push('TextModel got disposed before DiffEditorWidget model got reset');
            }
            if (model.disposed) violations.push('model disposed twice');
            model.disposed = true;
          },
        };
        models.push(model);
        return model;
      }),
      createDiffEditor: vi.fn(() => {
        const editor: Editor = {
          model: null, disposed: false,
          getModel: () => editor.model,
          setModel(model) { editor.model = model; },
          dispose() { editor.disposed = true; editor.model = null; },
          layout: vi.fn(), updateOptions: vi.fn(), getLineChanges: () => [],
          onDidUpdateDiff: () => ({ dispose: vi.fn() }),
        };
        editors.push(editor);
        return editor;
      }),
    },
  };
  return { models, editors, violations, monaco };
});

vi.mock('monaco-editor', () => runtime.monaco);
vi.mock('@renderer/lib/monaco-local', async () => {
  const { loader } = await import('@monaco-editor/react');
  return { configureLocalMonaco: () => loader.config({ monaco: runtime.monaco as never }) };
});

const props = { before: 'old text', after: 'new text', language: 'typescript' };
const liveModels = () => runtime.models.filter((model) => !model.disposed);
const liveEditors = () => runtime.editors.filter((editor) => !editor.disposed);
beforeEach(() => {
  runtime.models.length = 0;
  runtime.editors.length = 0;
  runtime.violations.length = 0;
  vi.clearAllMocks();
});
afterEach(cleanup);

function Comparison() {
  const [open, setOpen] = useState(false);
  return <>
    <MonacoDiffView {...props} />
    <button onClick={() => setOpen(true)}>放大</button>
    {open && <ExpandedDiffOverlay filePath="src/example.ts" onClose={() => setOpen(false)}>
      <MonacoDiffView {...props} />
    </ExpandedDiffOverlay>}
  </>;
}

describe('Monaco diff resource ownership', () => {
  it.each(['button', 'Escape'])('closes and reopens the overlay via %s without disposing the inline editor', async (action) => {
    const view = render(<Comparison />);
    await waitFor(() => expect(liveEditors()).toHaveLength(1));
    const inline = liveEditors()[0];
    for (let iteration = 0; iteration < 3; iteration++) {
      fireEvent.click(screen.getByRole('button', { name: '放大' }));
      await waitFor(() => expect(liveEditors()).toHaveLength(2));
      expect(liveModels()).toHaveLength(4);
      if (action === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: '关闭' }));
      await waitFor(() => expect(liveEditors()).toHaveLength(1));
      expect(liveEditors()[0]).toBe(inline);
      expect(inline.model?.modified.value).toBe('new text');
      expect(liveModels()).toHaveLength(2);
      expect(runtime.violations).toEqual([]);
    }
    view.unmount();
    expect(liveEditors()).toHaveLength(0);
    expect(liveModels()).toHaveLength(0);
    expect(runtime.violations).toEqual([]);
  });

  it('releases the previous comparison when file contents or language change', async () => {
    const view = render(<MonacoDiffView {...props} />);
    await waitFor(() => expect(liveEditors()).toHaveLength(1));
    const first = liveEditors()[0];
    view.rerender(<MonacoDiffView {...props} after="replacement" language="plaintext" />);
    await waitFor(() => expect(liveEditors()[0]?.model?.modified.value).toBe('replacement'));
    expect(first.disposed).toBe(true);
    expect(liveEditors()).toHaveLength(1);
    expect(liveModels()).toHaveLength(2);
    expect(runtime.violations).toEqual([]);
    view.unmount();
    expect(liveModels()).toHaveLength(0);
  });

  it('does not leak models across StrictMode setup and teardown', async () => {
    const view = render(<StrictMode><MonacoDiffView {...props} /></StrictMode>);
    await waitFor(() => expect(liveEditors()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('monaco-diff-surface').getAttribute('aria-busy')).toBe('false'));
    expect(liveModels()).toHaveLength(2);
    view.unmount();
    expect(liveModels()).toHaveLength(0);
    expect(liveEditors()).toHaveLength(0);
    expect(runtime.violations).toEqual([]);
  });

  it('leaves no live resources after an immediate close', async () => {
    const view = render(<MonacoDiffView {...props} />);
    view.unmount();
    await Promise.resolve();
    expect(liveModels()).toHaveLength(0);
    expect(liveEditors()).toHaveLength(0);
    expect(runtime.violations).toEqual([]);
  });

  it.each(['second-model', 'editor', 'onMount'])('cleans partially initialized resources after a %s failure', (stage) => {
    const failure = new Error('synthetic initialization failure');
    if (stage === 'second-model') {
      const create = runtime.monaco.editor.createModel.getMockImplementation()!;
      runtime.monaco.editor.createModel.mockImplementationOnce(create).mockImplementationOnce(() => { throw failure; });
    }
    if (stage === 'editor') runtime.monaco.editor.createDiffEditor.mockImplementationOnce(() => { throw failure; });
    expect(() => render(<MonacoDiffEditor original={props.before} modified={props.after} language={props.language}
      options={{}} onMount={() => { if (stage === 'onMount') throw failure; }} />)).toThrow(failure);
    expect(liveModels()).toHaveLength(0);
    expect(liveEditors()).toHaveLength(0);
    expect(runtime.violations).toEqual([]);
  });
});
