// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  TextDiffRenderer,
  normalizeCodexChangeKind,
  normalizeUnifiedDiffMetadata,
} from './TextDiffRenderer';

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

  it('renders codex unified diff metadata when before and after snapshots are absent', () => {
    const { container } = render(
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

    expect(container.textContent).toContain('@@ -1 +1 @@');
    expect(container.textContent).toContain('-old');
    expect(container.textContent).toContain('+new');
    expect(container.textContent).not.toContain('Codex 未提供可显示的差异内容');
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
