import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, ExpandIcon } from '../icons';
import { expandableContentKey } from './identity';
import {
  isTopExpandableLayer,
  mountedHeavyViewCount,
  registerExpandableLayer,
  registerHeavyView,
  subscribeExpandableLayers,
} from './layer-manager';
import type {
  ExpandableCloseBlockedEvent,
  ExpandableCloseReason,
  ExpandableContentIdentity,
  ExpandableContentPayload,
  ExpandableContentRenderContext,
  ExpandableHeavyViewSpec,
} from './types';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type ContentSlot<Payload extends ExpandableContentPayload> =
  | ReactNode
  | ((context: ExpandableContentRenderContext<Payload>) => ReactNode);

export interface ExpandableContentProps<Payload extends ExpandableContentPayload> {
  identity: ExpandableContentIdentity;
  payload: Payload;
  title: string;
  triggerLabel?: string;
  closeLabel?: string;
  /** The default positioning expects the caller's source surface to be relative. */
  triggerClassName?: string;
  panelClassName?: string;
  headerClassName?: string;
  children?: ContentSlot<Payload>;
  actions?: ContentSlot<Payload>;
  validation?: ContentSlot<Payload>;
  /** Dirty content blocks close unless confirmClose explicitly resolves true. */
  dirty?: boolean;
  confirmClose?: (reason: ExpandableCloseReason) => boolean | Promise<boolean>;
  onCloseBlocked?: (event: ExpandableCloseBlockedEvent) => void;
  onOpenChange?: (open: boolean, identity: ExpandableContentIdentity) => void;
  /** Monaco, image diff, and similar renderers belong here, never in children. */
  heavyView?: ExpandableHeavyViewSpec;
}

export interface ExpandableContentTriggerProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  label?: string;
}

export function ExpandableContentTrigger({
  label = '展开内容',
  className = '',
  ...props
}: ExpandableContentTriggerProps): JSX.Element {
  return (
    <button
      {...props}
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      className={`absolute right-1 top-1 z-10 flex h-11 w-11 touch-manipulation items-center justify-center rounded-md text-deck-muted transition-colors hover:bg-white/10 hover:text-deck-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-status-working ${className}`}
    >
      <ExpandIcon className="h-4 w-4" />
    </button>
  );
}

function renderSlot<Payload extends ExpandableContentPayload>(
  slot: ContentSlot<Payload> | undefined,
  context: ExpandableContentRenderContext<Payload>,
): ReactNode {
  return typeof slot === 'function' ? slot(context) : slot;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      !element.hidden
      && element.getAttribute('aria-hidden') !== 'true'
      && !element.closest('[inert]'),
  );
}

function HeavyView({
  contentKey,
  spec,
}: {
  contentKey: string;
  spec: ExpandableHeavyViewSpec;
}): JSX.Element {
  const tokenRef = useRef(Symbol(`expandable-heavy-view:${spec.id}`));
  const lifecycleRef = useRef(spec.onLifecycle);
  lifecycleRef.current = spec.onLifecycle;

  useLayoutEffect(() => {
    const release = registerHeavyView(tokenRef.current);
    lifecycleRef.current?.({
      state: 'mounted',
      viewId: spec.id,
      kind: spec.kind,
      contentKey,
      mountedCount: mountedHeavyViewCount(),
    });
    return () => {
      const mountedCount = release();
      lifecycleRef.current?.({
        state: 'unmounted',
        viewId: spec.id,
        kind: spec.kind,
        contentKey,
        mountedCount,
      });
    };
  }, [contentKey, spec.id, spec.kind]);

  return (
    <div
      className="min-h-0 min-w-0 flex-1"
      data-expandable-heavy-view={spec.kind}
      data-heavy-view-id={spec.id}
    >
      {spec.render()}
    </div>
  );
}

interface PanelProps<Payload extends ExpandableContentPayload>
  extends Omit<ExpandableContentProps<Payload>, 'triggerLabel' | 'triggerClassName' | 'onOpenChange'> {
  contentKey: string;
  onRequestClose: () => void;
}

function ExpandableContentPanel<Payload extends ExpandableContentPayload>({
  identity,
  payload,
  title,
  closeLabel = '关闭展开内容',
  children,
  actions,
  validation,
  dirty = false,
  confirmClose,
  onCloseBlocked,
  heavyView,
  panelClassName = '',
  headerClassName = '',
  contentKey,
  onRequestClose,
}: PanelProps<Payload>): JSX.Element {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef(Symbol(`expandable-layer:${contentKey}`));
  const mountedRef = useRef(true);
  const closeInFlightRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const isTopLayer = useSyncExternalStore(
    subscribeExpandableLayers,
    () => isTopExpandableLayer(tokenRef.current),
    () => false,
  );

  const requestClose = useCallback(async (
    reason: ExpandableCloseReason = 'close-button',
  ): Promise<boolean> => {
    if (closeInFlightRef.current) return false;
    if (dirty) {
      if (!confirmClose) {
        onCloseBlocked?.({ reason, cause: 'dirty-without-confirmation' });
        return false;
      }
      closeInFlightRef.current = true;
      setClosing(true);
      let confirmed = false;
      try {
        confirmed = await confirmClose(reason);
      } catch {
        closeInFlightRef.current = false;
        if (mountedRef.current) {
          setClosing(false);
          onCloseBlocked?.({ reason, cause: 'confirmation-error' });
        }
        return false;
      }
      if (!mountedRef.current) return false;
      closeInFlightRef.current = false;
      setClosing(false);
      if (!confirmed) {
        onCloseBlocked?.({ reason, cause: 'confirmation-declined' });
        return false;
      }
    }
    onRequestClose();
    return true;
  }, [confirmClose, dirty, onCloseBlocked, onRequestClose]);
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  const context: ExpandableContentRenderContext<Payload> = {
    identity,
    payload,
    contentKey,
    closing,
    requestClose,
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    mountedRef.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const unregister = registerExpandableLayer(tokenRef.current, root);
    root.focus();
    return () => {
      mountedRef.current = false;
      unregister();
      previousFocus?.focus();
    };
  }, [contentKey]);

  useEffect(() => {
    mountedRef.current = true;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isTopExpandableLayer(tokenRef.current)) return;
      if (event.key === 'Escape') {
        queueMicrotask(() => {
          if (!event.defaultPrevented && isTopExpandableLayer(tokenRef.current)) {
            void requestCloseRef.current('escape');
          }
        });
        return;
      }
      if (event.key !== 'Tab') return;
      const root = rootRef.current;
      if (!root) return;
      const focusable = focusableElements(root);
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
    return () => {
      mountedRef.current = false;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`no-drag fixed inset-0 z-[70] flex min-h-0 min-w-0 flex-col overflow-hidden bg-deck-bg-strong text-deck-text shadow-2xl outline-none ${panelClassName}`}
      data-expandable-content-key={contentKey}
    >
      <header className={`flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-deck-border px-3 py-2 sm:px-4 ${headerClassName}`}>
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium">
          {title}
        </h2>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {renderSlot(actions, context)}
          <button
            type="button"
            onClick={() => void requestClose('close-button')}
            disabled={closing}
            aria-label={closeLabel}
            title={closeLabel}
            aria-busy={closing || undefined}
            className="flex h-11 w-11 touch-manipulation items-center justify-center rounded-md text-deck-muted hover:bg-white/10 hover:text-deck-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-status-working disabled:opacity-40"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </header>
      {validation ? (
        <div className="shrink-0 border-b border-deck-border px-3 py-2 sm:px-4">
          {renderSlot(validation, context)}
        </div>
      ) : null}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-3 scrollbar-deck sm:p-4">
        {renderSlot(children, context)}
        {heavyView && isTopLayer ? (
          <HeavyView contentKey={contentKey} spec={heavyView} />
        ) : null}
      </main>
    </div>,
    document.body,
  );
}

export function ExpandableContent<Payload extends ExpandableContentPayload>({
  triggerLabel = '展开内容',
  triggerClassName,
  onOpenChange,
  ...props
}: ExpandableContentProps<Payload>): JSX.Element {
  const contentKey = expandableContentKey(props.identity);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openedIdentityRef = useRef<ExpandableContentIdentity | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const open = openKey === contentKey;

  useEffect(() => {
    if (openKey === null || openKey === contentKey) return;
    const openedIdentity = openedIdentityRef.current;
    setOpenKey(null);
    openedIdentityRef.current = null;
    if (openedIdentity) onOpenChangeRef.current?.(false, openedIdentity);
  }, [contentKey, openKey]);

  const openPanel = (): void => {
    openedIdentityRef.current = props.identity;
    setOpenKey(contentKey);
    onOpenChangeRef.current?.(true, props.identity);
  };
  const closePanel = (): void => {
    const openedIdentity = openedIdentityRef.current ?? props.identity;
    setOpenKey(null);
    openedIdentityRef.current = null;
    onOpenChangeRef.current?.(false, openedIdentity);
  };

  return (
    <>
      <ExpandableContentTrigger
        label={triggerLabel}
        className={triggerClassName}
        onClick={openPanel}
        aria-expanded={open}
      />
      {open ? (
        <ExpandableContentPanel
          key={contentKey}
          {...props}
          contentKey={contentKey}
          onRequestClose={closePanel}
        />
      ) : null}
    </>
  );
}
