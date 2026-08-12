import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import {
  isTopExpandableLayer,
  registerExpandableLayer,
} from './expandable-content/layer-manager';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'summary',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isRenderedFocusable(node: HTMLElement, root: HTMLElement): boolean {
  let current: HTMLElement | null = node;
  while (current && root.contains(current)) {
    if (
      current.hidden
      || current.inert
      || current.getAttribute('aria-hidden') === 'true'
    ) return false;
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (current instanceof HTMLDetailsElement && !current.open) {
      const summary = [...current.children]
        .find((child): child is HTMLElement => child instanceof HTMLElement &&
          child.tagName === 'SUMMARY');
      if (!summary?.contains(node)) return false;
    }
    if (current === root) break;
    current = current.parentElement;
  }
  return true;
}

export function useModalFocus({
  blocked = false,
  dialogRef,
  onClose,
  open = true,
}: {
  blocked?: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  onClose(): void;
  open?: boolean;
}): void {
  const tokenRef = useRef(Symbol('modal-layer'));
  const blockedRef = useRef(blocked);
  const closeRef = useRef(onClose);
  blockedRef.current = blocked;
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!open || !dialogRef.current) return;
    const root = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const unregister = registerExpandableLayer(tokenRef.current, root);
    root.focus();
    return () => {
      unregister();
      previousFocus?.focus();
    };
  }, [dialogRef, open]);

  useEffect(() => {
    if (!open) return;
    const escapeFromExpandedControl = new WeakSet<globalThis.KeyboardEvent>();
    const escapeFromCollapsedControl = new WeakSet<globalThis.KeyboardEvent>();
    const onKeyDownCapture = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || !(event.target instanceof Element)) return;
      const disclosure = event.target.closest('[aria-expanded]');
      if (!disclosure) return;
      if (disclosure.getAttribute('aria-expanded') === 'true') {
        escapeFromExpandedControl.add(event);
      } else {
        escapeFromCollapsedControl.add(event);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!isTopExpandableLayer(tokenRef.current)) return;
      if (event.key === 'Escape') {
        if (escapeFromExpandedControl.has(event)) return;
        if (event.defaultPrevented && !escapeFromCollapsedControl.has(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!blockedRef.current) closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((node) => isRenderedFocusable(node, root));
      event.preventDefault();
      event.stopPropagation();
      if (focusable.length === 0) {
        root.focus();
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1;
      focusable[nextIndex]?.focus();
    };
    document.addEventListener('keydown', onKeyDownCapture, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDownCapture, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [dialogRef, open]);
}
