// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { InertInteractionBoundary } from '../InertInteractionBoundary';

afterEach(cleanup);

describe('InertInteractionBoundary', () => {
  it('blocks interaction without visually disabling its child control', () => {
    const view = render(
      <InertInteractionBoundary blocked>
        <button type="button">保留展示</button>
      </InertInteractionBoundary>,
    );

    const button = screen.getByRole('button', { name: '保留展示', hidden: true });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.parentElement?.hasAttribute('inert')).toBe(true);
    expect(button.parentElement?.getAttribute('aria-disabled')).toBe('true');

    view.rerender(
      <InertInteractionBoundary blocked={false}>
        <button type="button">保留展示</button>
      </InertInteractionBoundary>,
    );
    expect(button.parentElement?.hasAttribute('inert')).toBe(false);
  });
});
