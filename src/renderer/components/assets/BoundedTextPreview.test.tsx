// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BoundedTextPreview } from './BoundedTextPreview';

afterEach(cleanup);

describe('BoundedTextPreview', () => {
  it('bounds the initial DOM and safely expands long unbroken content', () => {
    const content = 'x'.repeat(80_000);
    render(<BoundedTextPreview content={content} ariaLabel="Worker asset" />);

    const preview = screen.getByLabelText('Worker asset');
    expect(preview.textContent).toHaveLength(64 * 1024);
    expect(preview.className).toContain('[overflow-wrap:anywhere]');
    fireEvent.click(screen.getByRole('button', { name: /显示完整内容/u }));
    expect(preview.textContent).toHaveLength(content.length);
  });
});
