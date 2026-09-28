import {
  Window,
  type Document as HappyDocument,
  type DOMRect as HappyDOMRect,
  type Element as HappyElement,
  type Event as HappyEvent,
} from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

import { clickScript, snapshotScript } from '../scripts';

function makeVisible(element: HappyElement): void {
  element.setAttribute('style', 'display: block; visibility: visible; opacity: 1');
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, right: 80, bottom: 40, left: 0, width: 80, height: 40,
    toJSON: () => ({}),
  } as HappyDOMRect);
}

function svgButton(document: HappyDocument) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const button = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.setAttribute('aria-label', 'Canvas node');
  makeVisible(button);
  svg.append(button);
  return { svg, button };
}

function snapshotRef(window: Window, name: string): string {
  const snapshot = JSON.parse(window.eval(snapshotScript({
    limit: 20, includeText: false, textLimit: 0,
  })) as string) as { elements: Array<{ ref: string; name: string }> };
  const element = snapshot.elements.find((entry) => entry.name === name);
  expect(element, `snapshot ref for ${name}`).toBeDefined();
  return element!.ref;
}

describe('browser click scripts', () => {
  it('activates an SVG button from its snapshot ref and bubbles a cancellable click', () => {
    const window = new Window({ url: 'http://localhost/canvas' });
    const { svg, button } = svgButton(window.document);
    window.document.body.append(svg);
    const clicked = vi.fn((event: HappyEvent) => event.preventDefault());
    button.addEventListener('click', clicked);
    const delegated = vi.fn();
    svg.addEventListener('click', delegated);

    const ref = snapshotRef(window, 'Canvas node');
    const result = JSON.parse(window.eval(clickScript(ref)) as string);

    expect(result).toMatchObject({
      clicked: { tag: 'g', name: 'Canvas node' }, frameDepth: 0,
    });
    expect(clicked).toHaveBeenCalledOnce();
    expect(delegated).toHaveBeenCalledOnce();
    const event = clicked.mock.calls[0][0];
    expect(event).toBeInstanceOf(window.MouseEvent);
    expect(event.target).toBe(button);
    expect(event.defaultPrevented).toBe(true);
  });

  it('delivers an SVG click through an open shadow root to delegated listeners', () => {
    const window = new Window({ url: 'http://localhost/canvas' });
    const host = window.document.createElement('section');
    const shadow = host.attachShadow({ mode: 'open' });
    const { svg, button } = svgButton(window.document);
    shadow.append(svg);
    window.document.body.append(host);
    const clicked = vi.fn();
    const delegated = vi.fn();
    button.addEventListener('click', clicked);
    host.addEventListener('click', delegated);

    window.eval(clickScript(snapshotRef(window, 'Canvas node')));

    expect(clicked).toHaveBeenCalledOnce();
    expect(delegated).toHaveBeenCalledOnce();
  });

  it('creates an iframe SVG click in the target document realm', () => {
    const window = new Window({ url: 'http://localhost/canvas' });
    const frame = window.document.createElement('iframe');
    makeVisible(frame);
    window.document.body.append(frame);
    const frameDocument = frame.contentDocument!;
    const frameWindow = frameDocument.defaultView!;
    const { svg, button } = svgButton(frameDocument);
    frameDocument.body.append(svg);
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    class FrameMouseEvent extends frameWindow.MouseEvent {}
    Object.defineProperty(frameWindow, 'MouseEvent', { value: FrameMouseEvent });

    const result = JSON.parse(
      window.eval(clickScript(snapshotRef(window, 'Canvas node'))) as string,
    );

    expect(result.frameDepth).toBe(1);
    expect(clicked).toHaveBeenCalledOnce();
    expect(clicked.mock.calls[0][0]).toBeInstanceOf(FrameMouseEvent);
    expect(clicked.mock.calls[0][0].view).toBe(frameWindow);
  });

  it('preserves HTML checkbox activation and disabled-button behavior', () => {
    const window = new Window({ url: 'http://localhost/form' });
    const checkbox = window.document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', 'Select node');
    const disabled = window.document.createElement('button');
    disabled.disabled = true;
    disabled.textContent = 'Disabled action';
    makeVisible(checkbox);
    makeVisible(disabled);
    window.document.body.append(checkbox, disabled);
    const clicked = vi.fn();
    const disabledClicked = vi.fn();
    checkbox.addEventListener('click', clicked);
    disabled.addEventListener('click', disabledClicked);

    window.eval(clickScript(snapshotRef(window, 'Select node')));
    window.eval(clickScript(snapshotRef(window, 'Disabled action')));

    expect(checkbox.checked).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
    expect(disabledClicked).not.toHaveBeenCalled();
  });

  it('rejects stale and detached SVG refs before delivering a click', () => {
    const window = new Window({ url: 'http://localhost/canvas' });
    const { svg, button } = svgButton(window.document);
    window.document.body.append(svg);
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    const stale = snapshotRef(window, 'Canvas node');
    const current = snapshotRef(window, 'Canvas node');

    expect(() => window.eval(clickScript(stale))).toThrow('STALE_REF');
    button.remove();
    expect(() => window.eval(clickScript(current))).toThrow('DETACHED_REF');
    expect(clicked).not.toHaveBeenCalled();
  });
});
