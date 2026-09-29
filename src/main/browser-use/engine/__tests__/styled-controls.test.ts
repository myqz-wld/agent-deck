import { Window, type Element, type DOMRect } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { clickScript, snapshotScript } from '../scripts';

function sized(element: Element): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ width: 20, height: 20 } as DOMRect);
}

function fixture() {
  const window = new Window({ url: 'http://localhost/permissions' });
  window.document.body.innerHTML = `<label>Receive messages
    <input type="checkbox" style="opacity: 0"><span>✓</span>
  </label>`;
  const label = window.document.querySelector('label')!;
  const input = window.document.querySelector('input')!;
  sized(label);
  sized(input);
  const snapshot = () => JSON.parse(window.eval(snapshotScript({
    limit: 20, includeText: false, textLimit: 0,
  })) as string) as { elements: Array<{ ref: string; name: string; checked: boolean; disabled?: boolean }> };
  return { window, label, input, snapshot };
}

describe('styled native controls', () => {
  it.each(['checkbox', 'radio'])('exposes and activates a transparent %s with a visible label', (type) => {
    const { window, input, snapshot } = fixture();
    input.type = type;
    const change = vi.fn();
    input.addEventListener('change', change);
    const [entry] = snapshot().elements;
    expect(entry).toMatchObject({ name: 'Receive messages ✓', checked: false });
    window.eval(clickScript(entry.ref));
    expect(input.checked).toBe(true);
    expect(change).toHaveBeenCalledOnce();
    expect(snapshot().elements[0].checked).toBe(true);
  });

  it('keeps disabled state and native activation semantics', () => {
    const { window, input, snapshot } = fixture();
    input.disabled = true;
    const [entry] = snapshot().elements;
    expect(entry.disabled).toBe(true);
    window.eval(clickScript(entry.ref));
    expect(input.checked).toBe(false);
  });

  it.each(['display: none', 'visibility: hidden', 'opacity: 0'])('excludes a hidden label (%s)', (style) => {
    const { label, snapshot } = fixture();
    label.setAttribute('style', style);
    expect(snapshot().elements).toEqual([]);
  });

  it('excludes controls behind hidden ancestors and shadow hosts', () => {
    const { window, label, snapshot } = fixture();
    const host = window.document.createElement('div');
    host.style.opacity = '0';
    window.document.body.append(host);
    host.attachShadow({ mode: 'open' }).append(label);
    expect(snapshot().elements).toEqual([]);
    host.style.opacity = '1';
    expect(snapshot().elements).toHaveLength(1);
  });

  it('does not expose unlabeled, zero-sized or unrelated transparent inputs', () => {
    const { label, input, snapshot } = fixture();
    input.type = 'text';
    expect(snapshot().elements).toEqual([]);
    input.type = 'checkbox';
    label.after(input);
    expect(snapshot().elements).toEqual([]);
    input.id = 'scope';
    label.htmlFor = 'scope';
    expect(snapshot().elements).toHaveLength(1);
    vi.mocked(input.getBoundingClientRect).mockReturnValue({ width: 0, height: 0 } as DOMRect);
    expect(snapshot().elements).toEqual([]);
  });

  it('describes an empty table checkbox label using its bounded permission row', () => {
    const { window, label, input, snapshot } = fixture();
    label.replaceChildren(input);
    const row = window.document.createElement('div');
    row.setAttribute('role', 'row');
    row.append(label, 'Send as bot');
    window.document.body.append(row);
    expect(snapshot().elements[0].name).toBe('Send as bot');
  });

  it('preserves ref generations and detached-element rejection', () => {
    const { window, input, snapshot } = fixture();
    const stale = snapshot().elements[0].ref;
    const current = snapshot().elements[0].ref;
    expect(() => window.eval(clickScript(stale))).toThrow('STALE_REF');
    input.remove();
    expect(() => window.eval(clickScript(current))).toThrow('DETACHED_REF');
  });
});
