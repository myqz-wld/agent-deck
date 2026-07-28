import {
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import {
  isTopExpandableLayer,
  registerExpandableLayer,
} from '../../expandable-content/layer-manager';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface Options {
  open: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  planRef: RefObject<HTMLDivElement | null>;
  questionRef: RefObject<HTMLTextAreaElement | null>;
  closeBlocked: boolean;
  quoteMenuOpen: boolean;
  onClose: () => void;
  closeQuoteMenu: () => void;
}

/**
 * Dedicated plan review uses the shared layer ownership and document isolation.
 * The quote menu remains the nested Escape/Tab layer inside this one surface.
 */
export function useReviewDialogFocus({
  open,
  dialogRef,
  closeButtonRef,
  planRef,
  questionRef,
  closeBlocked,
  quoteMenuOpen,
  onClose,
  closeQuoteMenu,
}: Options): void {
  const tokenRef = useRef(Symbol('plan-deep-review-layer'));
  const closeBlockedRef = useRef(closeBlocked);
  const quoteMenuOpenRef = useRef(quoteMenuOpen);
  const onCloseRef = useRef(onClose);
  const closeQuoteMenuRef = useRef(closeQuoteMenu);
  closeBlockedRef.current = closeBlocked;
  quoteMenuOpenRef.current = quoteMenuOpen;
  onCloseRef.current = onClose;
  closeQuoteMenuRef.current = closeQuoteMenu;

  useLayoutEffect(() => {
    if (!open || !dialogRef.current) return;
    const root = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const unregister = registerExpandableLayer(tokenRef.current, root);
    root.focus();
    return () => {
      unregister();
      previousFocus?.focus();
    };
  }, [dialogRef, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || !isTopExpandableLayer(tokenRef.current)) return;
      if (quoteMenuOpenRef.current && (event.key === 'Escape' || event.key === 'Tab')) {
        event.preventDefault();
        event.stopPropagation();
        const focusTarget = event.key === 'Escape'
          ? planRef.current
          : event.shiftKey ? closeButtonRef.current : questionRef.current;
        closeQuoteMenuRef.current();
        requestAnimationFrame(() => focusTarget?.focus());
        return;
      }
      if (event.key === 'Escape') {
        queueMicrotask(() => {
          if (
            !event.defaultPrevented
            && isTopExpandableLayer(tokenRef.current)
            && !closeBlockedRef.current
          ) {
            onCloseRef.current();
          }
        });
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((node) =>
          !node.hidden
          && node.getAttribute('aria-hidden') !== 'true'
          && !node.closest('[inert]'));
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
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeButtonRef, dialogRef, open, planRef, questionRef]);
}
