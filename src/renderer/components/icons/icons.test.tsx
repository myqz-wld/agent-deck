// @vitest-environment happy-dom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PushpinIcon } from '.';
import { SvgIcon } from './SvgIcon';

describe('renderer SVG chrome', () => {
  it('keeps decorative icons currentColor and hidden from accessibility by default', () => {
    const { container } = render(<SvgIcon><path d="M1 1h2" /></SvgIcon>);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
  });

  it('uses the exact same pushpin geometry for outlined and filled states', () => {
    const outlined = render(<PushpinIcon />).container;
    const filled = render(<PushpinIcon filled />).container;
    const outlinedPaths = [...outlined.querySelectorAll('path')];
    const filledPaths = [...filled.querySelectorAll('path')];
    expect(outlinedPaths.map((path) => path.getAttribute('d'))).toEqual(
      filledPaths.map((path) => path.getAttribute('d')),
    );
    expect(outlinedPaths[0]?.getAttribute('fill')).toBe('none');
    expect(filledPaths[0]?.getAttribute('fill')).toBe('currentColor');
    expect(outlinedPaths[0]?.getAttribute('d')).toBe('M9 3h6l-.8 6 2.8 2v2H7v-2l2.8-2L9 3Z');
  });

  it('can carry an accessible label when the SVG is meaningful on its own', () => {
    const { getByRole } = render(<PushpinIcon label="已置顶" filled />);
    expect(getByRole('img', { name: '已置顶' })).toBeTruthy();
  });
});
