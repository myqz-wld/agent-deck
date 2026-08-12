// @vitest-environment happy-dom
import { useRef, useState, type JSX } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeckSelect } from './DeckSelect';
import { useModalFocus } from './use-modal-focus';

afterEach(cleanup);

function FocusFixture({ blocked = false, onClose }: {
  blocked?: boolean;
  onClose(): void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus({ blocked, dialogRef, onClose });
  return (
    <div ref={dialogRef} role="dialog" tabIndex={-1}>
      <button type="button">第一个</button>
      <details>
        <summary>可见摘要</summary>
        <button type="button">关闭详情中的按钮</button>
      </details>
      <button type="button" hidden>隐藏按钮</button>
      <button type="button">最后一个</button>
    </div>
  );
}

describe('useModalFocus', () => {
  it('traps focus in both directions while excluding non-rendered detail descendants', () => {
    render(<FocusFixture onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '第一个' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('可见摘要'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '最后一个' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('可见摘要'));
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: '关闭详情中的按钮', hidden: true }),
    );
  });

  it('lets an inner DeckSelect consume Escape before closing the modal', () => {
    const onClose = vi.fn();
    function Fixture(): JSX.Element {
      const dialogRef = useRef<HTMLDivElement>(null);
      const [value, setValue] = useState('a');
      useModalFocus({ dialogRef, onClose });
      return (
        <div ref={dialogRef} role="dialog" tabIndex={-1}>
          <DeckSelect
            ariaLabel="测试选项"
            value={value}
            options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]}
            onChange={setValue}
          />
        </div>
      );
    }
    render(<Fixture />);
    const select = screen.getByRole('button', { name: '测试选项' });
    fireEvent.click(select);
    expect(select.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(select, { key: 'Escape' });
    expect(select.getAttribute('aria-expanded')).toBe('false');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(select, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks Escape while busy', () => {
    const onClose = vi.fn();
    render(<FocusFixture blocked onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
