import {
  Window,
  type DOMRect as HappyDOMRect,
  type Element as HappyElement,
  type HTMLButtonElement as HappyButtonElement,
  type HTMLElement as HappyHtmlElement,
  type HTMLIFrameElement as HappyFrameElement,
  type HTMLInputElement as HappyInputElement,
} from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  clickScript,
  scrollScript,
  selectorProbeScript,
  snapshotScript,
  typeScript,
} from '../scripts';
import { pressFallbackScript } from '../key-script';

function makeVisible(element: HappyElement): void {
  const htmlElement = element as HappyHtmlElement;
  htmlElement.style.display = 'block';
  htmlElement.style.visibility = 'visible';
  htmlElement.style.opacity = '1';
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 40,
    bottom: 20,
    left: 0,
    width: 40,
    height: 20,
    toJSON: () => ({}),
  } as HappyDOMRect);
}

function parseScript(window: Window, script: string): Record<string, any> {
  return JSON.parse(window.eval(script) as string) as Record<string, any>;
}

function fixture(): {
  window: Window;
  topButton: HappyButtonElement;
  shadowButton: HappyButtonElement;
  frame: HappyFrameElement;
  frameButton: HappyButtonElement;
  frameInput: HappyInputElement;
  nestedFrame: HappyFrameElement;
  nestedButton: HappyButtonElement;
} {
  const window = new Window({ url: 'http://localhost/dashboard' });
  const { document } = window;

  const topButton = document.createElement('button');
  topButton.textContent = 'Top action';
  makeVisible(topButton);
  document.body.append(topButton);

  const shadowHost = document.createElement('section');
  const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
  const shadowButton = document.createElement('button');
  shadowButton.textContent = 'Shadow action';
  makeVisible(shadowButton);
  shadowRoot.append(shadowButton);
  document.body.append(shadowHost);

  const frame = document.createElement('iframe');
  makeVisible(frame);
  document.body.append(frame);
  const frameDocument = frame.contentDocument;
  if (frameDocument == null) throw new Error('happy-dom did not create an iframe document');
  const frameButton = frameDocument.createElement('button');
  frameButton.textContent = 'Frame action';
  makeVisible(frameButton);
  const frameInput = frameDocument.createElement('input');
  frameInput.setAttribute('aria-label', 'Frame input');
  makeVisible(frameInput);
  frameDocument.body.append(frameButton, frameInput);

  const nestedFrame = frameDocument.createElement('iframe');
  makeVisible(nestedFrame);
  frameDocument.body.append(nestedFrame);
  const nestedDocument = nestedFrame.contentDocument;
  if (nestedDocument == null) throw new Error('happy-dom did not create a nested iframe document');
  const nestedButton = nestedDocument.createElement('button');
  nestedButton.textContent = 'Nested frame action';
  makeVisible(nestedButton);
  nestedDocument.body.append(nestedButton);

  const inaccessibleFrame = document.createElement('iframe');
  Object.defineProperty(inaccessibleFrame, 'contentDocument', { value: null });
  document.body.append(inaccessibleFrame);

  return {
    window,
    topButton,
    shadowButton,
    frame,
    frameButton,
    frameInput,
    nestedFrame,
    nestedButton,
  };
}

describe('open-DOM browser scripts', () => {
  it('flattens open shadow roots and same-origin nested frames into stable refs', () => {
    const { window } = fixture();

    const snapshot = parseScript(
      window,
      snapshotScript({ limit: 20, includeText: true, textLimit: 2_000 }),
    );

    expect(snapshot.elements.map((element: { name: string }) => element.name)).toEqual([
      'Top action',
      'Shadow action',
      'Frame action',
      'Frame input',
      'Nested frame action',
    ]);
    expect(snapshot.elements.map((element: { ref: string }) => element.ref)).toEqual([
      '1-1',
      '1-2',
      '1-3',
      '1-4',
      '1-5',
    ]);
    expect(snapshot.elements[1]).toMatchObject({ shadowDepth: 1 });
    expect(snapshot.elements[2]).toMatchObject({ frameDepth: 1 });
    expect(snapshot.elements[4]).toMatchObject({ frameDepth: 2 });
    expect(snapshot.coverage).toMatchObject({
      documents: 3,
      sameOriginFrames: 2,
      inaccessibleFrames: 1,
      openShadowRoots: 1,
      closedShadowRoots: 'not-observable',
      scanLimitReached: false,
    });
    expect(snapshot.coverage.scannedNodes).toBeGreaterThan(
      snapshot.coverage.scannedElements,
    );
    expect(snapshot.text).toContain('Frame action');
    expect(snapshot.textTruncated).toBe(false);
  });

  it('clicks, types, and scrolls through a frame ref without changing its format', () => {
    const { window, frame, frameButton, frameInput, nestedFrame, nestedButton } = fixture();
    const snapshot = parseScript(
      window,
      snapshotScript({ limit: 20, includeText: false, textLimit: 0 }),
    );
    const frameButtonRef = snapshot.elements.find(
      (element: { name: string }) => element.name === 'Frame action',
    ).ref as string;
    const frameInputRef = snapshot.elements.find(
      (element: { name: string }) => element.name === 'Frame input',
    ).ref as string;
    const nestedButtonRef = snapshot.elements.find(
      (element: { name: string }) => element.name === 'Nested frame action',
    ).ref as string;
    const clicked = vi.fn();
    frameButton.addEventListener('click', clicked);
    const frameScroll = vi.fn();
    const buttonScroll = vi.fn();
    frame.scrollIntoView = frameScroll;
    frameButton.scrollIntoView = buttonScroll;

    const click = parseScript(window, clickScript(frameButtonRef));
    expect(clicked).toHaveBeenCalledOnce();
    expect(click.frameDepth).toBe(1);

    parseScript(
      window,
      scrollScript({ ref: frameButtonRef, dx: 0, dy: 0 }),
    );
    expect(frameScroll).toHaveBeenCalled();
    expect(buttonScroll).toHaveBeenCalled();

    const nestedFrameScroll = vi.fn();
    const nestedButtonScroll = vi.fn();
    nestedFrame.scrollIntoView = nestedFrameScroll;
    nestedButton.scrollIntoView = nestedButtonScroll;
    const nestedScroll = parseScript(
      window,
      scrollScript({ ref: nestedButtonRef, dx: 0, dy: 0 }),
    );
    expect(frameScroll).toHaveBeenCalled();
    expect(nestedFrameScroll).toHaveBeenCalled();
    expect(nestedButtonScroll).toHaveBeenCalled();
    expect(nestedScroll.frameDepth).toBe(2);

    const inputEvents = vi.fn();
    frameInput.addEventListener('input', inputEvents);
    const typed = parseScript(window, typeScript(frameInputRef, 'hello', true));
    expect(frameInput.value).toBe('hello');
    expect(inputEvents).toHaveBeenCalledOnce();
    expect(typed.frameDepth).toBe(1);
  });

  it('queries readiness across the same open-DOM scope', () => {
    const { window, shadowButton, frameButton, nestedButton } = fixture();
    shadowButton.className = 'ready';
    frameButton.className = 'ready';
    nestedButton.className = 'ready';

    const probe = parseScript(window, selectorProbeScript('.ready'));

    expect(probe).toMatchObject({ count: 3, visibleCount: 3 });
    expect(probe.coverage).toMatchObject({
      sameOriginFrames: 2,
      openShadowRoots: 1,
      inaccessibleFrames: 1,
    });
  });

  it('rejects refs when their owning frame host detaches', () => {
    const { window, frame } = fixture();
    const snapshot = parseScript(
      window,
      snapshotScript({ limit: 20, includeText: false, textLimit: 0 }),
    );
    const ref = snapshot.elements.find(
      (element: { name: string }) => element.name === 'Frame action',
    ).ref as string;
    frame.remove();

    expect(() => window.eval(clickScript(ref))).toThrow(/DETACHED_REF/);
  });

  it('delivers background key fallback to the deep active iframe element', () => {
    const { window, frame, frameInput } = fixture();
    frame.focus();
    frameInput.focus();

    const result = parseScript(window, pressFallbackScript('x'));

    expect(frameInput.value).toBe('x');
    expect(result).toMatchObject({ pressed: 'x', effect: 'inserted' });
  });

  it('bounds returned text without reading whole-document innerText', () => {
    const { window } = fixture();

    const snapshot = parseScript(
      window,
      snapshotScript({ limit: 20, includeText: true, textLimit: 8 }),
    );

    expect(snapshot.text.length).toBeLessThanOrEqual(8);
    expect(snapshot.textTruncated).toBe(true);
    expect(snapshot.coverage.scannedNodes).toBeGreaterThan(0);
  });

  it('reproduces editing defaults for background text controls', () => {
    const window = new Window({ url: 'http://localhost/form' });
    const input = window.document.createElement('input');
    input.value = 'abcd';
    window.document.body.append(input);
    input.focus();
    input.setSelectionRange(2, 2);

    expect(parseScript(window, pressFallbackScript('Backspace')).effect).toBe('deleted');
    expect(input.value).toBe('acd');
    expect(input.selectionStart).toBe(1);

    expect(parseScript(window, pressFallbackScript('Delete')).effect).toBe('deleted');
    expect(input.value).toBe('ad');

    input.setSelectionRange(1, 1);
    expect(parseScript(window, pressFallbackScript('ArrowRight')).effect).toBe('caret-moved');
    expect(input.selectionStart).toBe(2);
    expect(parseScript(window, pressFallbackScript('Home')).effect).toBe('caret-moved');
    expect(input.selectionStart).toBe(0);
    expect(parseScript(window, pressFallbackScript('End')).effect).toBe('caret-moved');
    expect(input.selectionStart).toBe(2);
  });

  it('inserts a newline in textarea instead of submitting its form', () => {
    const window = new Window({ url: 'http://localhost/form' });
    const form = window.document.createElement('form');
    const textarea = window.document.createElement('textarea');
    const submit = vi.fn();
    form.requestSubmit = submit;
    form.append(textarea);
    window.document.body.append(form);
    textarea.focus();

    const result = parseScript(window, pressFallbackScript('Enter'));

    expect(result.effect).toBe('inserted');
    expect(textarea.value).toBe('\n');
    expect(submit).not.toHaveBeenCalled();
  });

  it('reproduces select, activation, and form-submit defaults', () => {
    const window = new Window({ url: 'http://localhost/form' });
    const select = window.document.createElement('select');
    select.append(
      window.document.createElement('option'),
      window.document.createElement('option'),
    );
    window.document.body.append(select);
    select.focus();
    expect(parseScript(window, pressFallbackScript('ArrowDown')).effect).toBe(
      'selection-changed',
    );
    expect(select.selectedIndex).toBe(1);

    const checkbox = window.document.createElement('input');
    checkbox.type = 'checkbox';
    window.document.body.append(checkbox);
    checkbox.focus();
    expect(parseScript(window, pressFallbackScript(' ')).effect).toBe('activated');
    expect(checkbox.checked).toBe(true);

    const form = window.document.createElement('form');
    const input = window.document.createElement('input');
    const submit = vi.fn();
    form.requestSubmit = submit;
    form.append(input);
    window.document.body.append(form);
    input.focus();
    expect(parseScript(window, pressFallbackScript('Enter')).effect).toBe('submitted');
    expect(submit).toHaveBeenCalledOnce();
  });

  it('dismisses a native dialog with background Escape', () => {
    const window = new Window({ url: 'http://localhost/dialog' });
    const dialog = window.document.createElement('dialog');
    const button = window.document.createElement('button');
    dialog.setAttribute('open', '');
    dialog.append(button);
    window.document.body.append(dialog);
    Object.defineProperty(dialog, 'open', {
      configurable: true,
      get: () => dialog.hasAttribute('open'),
    });
    Object.defineProperty(dialog, 'close', {
      configurable: true,
      value: () => dialog.removeAttribute('open'),
    });
    button.focus();

    const result = parseScript(window, pressFallbackScript('Escape'));

    expect(result.effect).toBe('dismissed');
    expect(dialog.hasAttribute('open')).toBe(false);
  });
});
