// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StableButtonContent } from '../StableButtonContent';

afterEach(cleanup);

describe('StableButtonContent', () => {
  it('retains every sizing variant while exposing only the active label', () => {
    const variants = [
      { key: 'idle', content: <>发送</> },
      { key: 'busy', content: <>发送中…</> },
    ];
    const view = render(
      <button type="button">
        <StableButtonContent activeKey="idle" variants={variants} />
      </button>,
    );

    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    const busy = view.container.querySelector('[data-stable-button-variant="busy"]');
    expect(busy?.className).toContain('invisible');
    expect(busy?.getAttribute('aria-hidden')).toBe('true');

    view.rerender(
      <button type="button">
        <StableButtonContent activeKey="busy" variants={variants} />
      </button>,
    );
    expect(screen.getByRole('button', { name: '发送中…' })).toBeTruthy();
    expect(view.container.querySelectorAll('[data-stable-button-variant]')).toHaveLength(2);
  });
});
