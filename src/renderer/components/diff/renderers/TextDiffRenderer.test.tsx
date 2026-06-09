// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TextDiffRenderer, normalizeCodexChangeKind } from './TextDiffRenderer';

describe('TextDiffRenderer codex metadata', () => {
  it('normalizes old persisted changeKind objects', () => {
    expect(normalizeCodexChangeKind({ type: 'update', move_path: null })).toBe('update');
  });

  it('renders meta-only codex changes when changeKind is an object', () => {
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
    expect(screen.getByText(/Codex 仅记录改动路径/)).toBeTruthy();
  });
});
