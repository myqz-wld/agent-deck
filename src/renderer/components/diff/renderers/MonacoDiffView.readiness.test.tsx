// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import type { DiffOnMount } from '@monaco-editor/react';
import { DiffLoadingDeadlineProvider } from '../LoadingContext';
import { MonacoDiffView } from './MonacoDiffView';

const state = vi.hoisted(() => ({ mounts: [] as DiffOnMount[] }));
vi.mock('@renderer/lib/monaco-local', () => ({ configureLocalMonaco: vi.fn() }));
vi.mock('./MonacoDiffEditor', () => ({ MonacoDiffEditor: ({ onMount }: {
  onMount: DiffOnMount;
}) => {
  useEffect(() => { state.mounts.push(onMount); }, []);
  return <div data-testid="editor" />;
} }));

const props = { before: 'old', after: 'new', language: 'typescript' };
beforeAll(async () => {
  const view = render(<MonacoDiffView {...props} />);
  await waitFor(() => expect(state.mounts.length).toBeGreaterThan(0));
  view.unmount();
});
beforeEach(() => { state.mounts = []; vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function mountEditor(index = 0) {
  let updated!: () => void;
  const editor = { layout: vi.fn(), getLineChanges: () => null,
    onDidUpdateDiff: (callback: () => void) => { updated = callback; return { dispose: vi.fn() }; } };
  act(() => state.mounts[index](editor as unknown as Parameters<DiffOnMount>[0], {} as Parameters<DiffOnMount>[1]));
  return { computed: () => act(() => updated()), editor };
}

describe('diff editor presentation readiness', () => {
  it('keeps fast initialization silent and reveals only the computed, laid-out editor', async () => {
    render(<MonacoDiffView {...props} />);
    const model = mountEditor();
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('monaco-diff-surface').getAttribute('aria-busy')).toBe('true');
    await act(() => vi.advanceTimersByTimeAsync(50));
    model.computed();
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(model.editor.layout).toHaveBeenCalled();
    expect(screen.getByTestId('monaco-diff-surface').getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows slow progress only at 150 ms and keeps it until the first diff is ready', async () => {
    render(<MonacoDiffView {...props} />);
    const model = mountEditor();
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(screen.queryByRole('status')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole('status').textContent).toBe('加载改动…');
    model.computed();
    expect(screen.getByRole('status')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses the remaining payload grace instead of starting a second 150 ms delay', async () => {
    render(<DiffLoadingDeadlineProvider value={Date.now() + 50}><MonacoDiffView {...props} /></DiffLoadingDeadlineProvider>);
    await act(() => vi.advanceTimersByTimeAsync(49));
    expect(screen.queryByRole('status')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('retains an already-earned loading indication across the payload/editor handoff', () => {
    render(<DiffLoadingDeadlineProvider value={Date.now() - 1}><MonacoDiffView {...props} /></DiffLoadingDeadlineProvider>);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('does not let an old model callback reveal a replacement model', async () => {
    const view = render(<MonacoDiffView {...props} />);
    const old = mountEditor();
    view.rerender(<MonacoDiffView {...props} after="replacement" />);
    const next = mountEditor(1);
    old.computed();
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(screen.getByTestId('monaco-diff-surface').getAttribute('aria-busy')).toBe('true');
    next.computed();
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(screen.getByTestId('monaco-diff-surface').getAttribute('aria-busy')).toBe('false');
  });
});
