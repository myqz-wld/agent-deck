// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DataUrlImageLightbox } from '../ImageLightbox';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=';
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
const idle = () => act(() => { vi.advanceTimersByTime(2000); });

describe('image preview controls', () => {
  it('fades idle actions, reveals them on pointer movement, and keeps hovered actions visible', () => {
    render(<DataUrlImageLightbox dataUrl={PNG} onClose={vi.fn()} onSave={vi.fn()} />);
    const toolbar = screen.getByRole('toolbar', { name: '图片操作' });
    expect(toolbar.className).toContain('opacity-100');
    idle();
    expect(toolbar.className).toContain('pointer-events-none opacity-0');
    fireEvent.pointerMove(screen.getByRole('dialog'));
    expect(toolbar.className).toContain('opacity-100');
    fireEvent.pointerEnter(toolbar);
    idle();
    expect(toolbar.className).toContain('opacity-100');
    fireEvent.pointerLeave(toolbar);
    idle();
    expect(toolbar.className).toContain('opacity-0');
  });
  it('keeps keyboard navigation visible and traps focus until Escape closes the preview', () => {
    const close = vi.fn();
    render(<DataUrlImageLightbox dataUrl={PNG} onClose={close} onSave={vi.fn()} />);
    idle();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '保存图片' }));
    idle();
    expect(screen.getByRole('toolbar').className).toContain('opacity-100');
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭预览' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
  it('holds actions during saving, reports completion, and does not close when saving', () => {
    const save = vi.fn();
    const close = vi.fn();
    const props = { dataUrl: PNG, onClose: close, onSave: save };
    const { rerender } = render(<DataUrlImageLightbox {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '保存图片' }));
    expect(save).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    rerender(<DataUrlImageLightbox {...props} saving />);
    idle();
    expect(screen.getByRole('toolbar').className).toContain('opacity-100');
    expect((screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<DataUrlImageLightbox {...props} notice="图片已保存" />);
    expect(screen.getByRole('status').textContent).toBe('图片已保存');
    idle();
    expect(screen.getByRole('toolbar').className).toContain('opacity-0');
  });
});
