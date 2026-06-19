// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  TextDiffRenderer,
  normalizeCodexChangeKind,
  normalizeUnifiedDiffMetadata,
  reconstructUnifiedDiffSnapshots,
} from './TextDiffRenderer';

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react');
  return {
    DiffEditor: ({
      original,
      modified,
    }: {
      original: string;
      modified: string;
    }) =>
      React.createElement('div', {
        'data-testid': 'diff-editor',
        'data-original': original,
        'data-modified': modified,
      }),
  };
});

afterEach(() => cleanup());

describe('TextDiffRenderer codex metadata', () => {
  it('normalizes old persisted changeKind objects', () => {
    expect(normalizeCodexChangeKind({ type: 'update', move_path: null })).toBe('update');
  });

  it('normalizes codex unified diff metadata', () => {
    expect(normalizeUnifiedDiffMetadata('\n@@ -1 +1 @@\n-old\n+new\n')).toBe(
      '\n@@ -1 +1 @@\n-old\n+new\n',
    );
    expect(normalizeUnifiedDiffMetadata('   ')).toBeNull();
    expect(normalizeUnifiedDiffMetadata({ diff: 'x' })).toBeNull();
  });

  it('reconstructs snapshots from a bare unified diff hunk', () => {
    expect(reconstructUnifiedDiffSnapshots('@@ -1 +1 @@\n-old\n+new')).toEqual({
      before: 'old',
      after: 'new',
    });
  });

  it('reconstructs snapshots from a git diff with context and insertions', () => {
    expect(
      reconstructUnifiedDiffSnapshots(
        [
          'diff --git a/ref/changelogs/INDEX.md b/ref/changelogs/INDEX.md',
          '--- a/ref/changelogs/INDEX.md',
          '+++ b/ref/changelogs/INDEX.md',
          '@@ -6,2 +6,3 @@',
          ' |------|------|',
          '+| [CHANGELOG_10.md](CHANGELOG_10.md) | AGENTS.md 与入口差异 |',
          ' | [CHANGELOG_9.md](CHANGELOG_9.md) | 入口资产去重 |',
        ].join('\n'),
      ),
    ).toEqual({
      before: '|------|------|\n| [CHANGELOG_9.md](CHANGELOG_9.md) | 入口资产去重 |',
      after:
        '|------|------|\n' +
        '| [CHANGELOG_10.md](CHANGELOG_10.md) | AGENTS.md 与入口差异 |\n' +
        '| [CHANGELOG_9.md](CHANGELOG_9.md) | 入口资产去重 |',
    });
  });

  it('returns null when a unified diff has no parseable hunk lines', () => {
    expect(reconstructUnifiedDiffSnapshots('Binary files a/x.png and b/x.png differ')).toBeNull();
  });

  it('renders codex unified diff metadata through the Monaco diff path', async () => {
    render(
      <TextDiffRenderer
        payload={{
          kind: 'text',
          filePath: '/tmp/a.ts',
          before: null,
          after: null,
          metadata: {
            source: 'codex',
            changeKind: 'update',
            patchStatus: 'completed',
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
          ts: 1,
        }}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('diff-editor')).toBeTruthy());
    expect(screen.getByTestId('diff-editor').getAttribute('data-original')).toBe('old');
    expect(screen.getByTestId('diff-editor').getAttribute('data-modified')).toBe('new');
    expect(screen.queryByText(/Codex 未提供可显示的差异内容/)).toBeNull();
  });

  it('renders whole-file additions with a green full-file background', () => {
    render(
      <TextDiffRenderer
        payload={{
          kind: 'text',
          filePath: '/tmp/new.ts',
          before: null,
          after: 'first\nsecond\n',
          ts: 1,
        }}
      />,
    );

    const panel = screen.getByTestId('full-file-diff');
    expect(panel.getAttribute('data-change-kind')).toBe('added');
    expect(panel.className).toContain('bg-status-working/10');
    expect(panel.textContent).toContain('+first');
    expect(screen.queryByTestId('diff-editor')).toBeNull();
  });

  it('renders whole-file deletions with a red full-file background', () => {
    render(
      <TextDiffRenderer
        payload={{
          kind: 'text',
          filePath: '/tmp/old.ts',
          before: 'old\ncontent\n',
          after: null,
          ts: 1,
        }}
      />,
    );

    const panel = screen.getByTestId('full-file-diff');
    expect(panel.getAttribute('data-change-kind')).toBe('deleted');
    expect(panel.className).toContain('bg-status-error/10');
    expect(panel.textContent).toContain('-old');
    expect(screen.getByText('删除')).toBeTruthy();
    expect(screen.queryByTestId('diff-editor')).toBeNull();
  });

  it('renders git new-file unified diff metadata with a green full-file background', () => {
    render(
      <TextDiffRenderer
        payload={{
          kind: 'text',
          filePath: '/tmp/new.ts',
          before: null,
          after: null,
          metadata: {
            source: 'recorded-patch-fallback',
            diff: [
              'diff --git a/tmp/new.ts b/tmp/new.ts',
              'new file mode 100644',
              '--- /dev/null',
              '+++ b/tmp/new.ts',
              '@@ -0,0 +1,2 @@',
              '+first',
              '+second',
            ].join('\n'),
          },
          ts: 1,
        }}
      />,
    );

    const panel = screen.getByTestId('full-file-diff');
    expect(panel.getAttribute('data-change-kind')).toBe('added');
    expect(panel.className).toContain('bg-status-working/10');
    expect(panel.textContent).toContain('+first');
    expect(screen.queryByTestId('diff-editor')).toBeNull();
  });

  it('keeps raw patch fallback when unified diff metadata cannot be reconstructed', () => {
    const { container } = render(
      <TextDiffRenderer
        payload={{
          kind: 'text',
          filePath: '/tmp/a.png',
          before: null,
          after: null,
          metadata: {
            source: 'recorded-patch-fallback',
            diff: 'Binary files a/tmp/a.png and b/tmp/a.png differ',
          },
          ts: 1,
        }}
      />,
    );

    expect(container.textContent).toContain('Binary files a/tmp/a.png and b/tmp/a.png differ');
  });

  it('renders codex fallback when changeKind is an object and diff is absent', () => {
    render(
      <TextDiffRenderer
        payload={{
          kind: 'text',
          filePath: '/tmp/a.ts',
          before: null,
          after: null,
          metadata: {
            source: 'codex',
            changeKind: { type: 'update', move_path: null },
            patchStatus: 'completed',
          },
          ts: 1,
        }}
      />,
    );

    expect(screen.getByText('update')).toBeTruthy();
    expect(screen.getByText(/Codex 未提供可显示的差异内容/)).toBeTruthy();
  });
});
