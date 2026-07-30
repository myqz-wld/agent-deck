// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AdapterSubTab } from './AdapterSubTab';

afterEach(cleanup);

describe('AdapterSubTab', () => {
  it('keeps asset adapter tabs compact', () => {
    render(
      <AdapterSubTab
        current="claude-code"
        onSelect={vi.fn()}
        showGrok
      />,
    );

    for (const label of ['Claude Code', 'Codex CLI', 'Grok Build']) {
      const tab = screen.getByRole('button', { name: label });
      expect(tab.className).toContain('py-0.5');
      expect(tab.className).not.toContain('min-h-11');
    }
  });
});
