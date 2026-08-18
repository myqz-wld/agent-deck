// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemo } from 'react';

import type { BrowserAnnotationCapture, BrowserStateSnapshot } from '@shared/browser-view';
import { IabPanel } from './IabPanel';
import {
  IabComposerBridgeProvider,
  unsupportedIabComposerTarget,
  useRegisterIabComposerTarget,
  type IabComposerTarget,
} from './iab-composer-bridge';

vi.mock('./IabAnnotationCanvas', () => ({
  IabAnnotationCanvas: ({ onCancel, onComplete }: {
    onCancel: () => void;
    onComplete: (file: File) => Promise<boolean>;
  }) => (
    <div data-testid="annotation-canvas">
      <button type="button" onClick={onCancel}>取消测试标注</button>
      <button
        type="button"
        onClick={() => void onComplete(new File(['png'], 'iab-annotation.png', {
          type: 'image/png',
        }))}
      >
        完成测试标注
      </button>
    </div>
  ),
}));

const source = { kind: 'local' as const, sessionId: 'session-a' };
const snapshot: BrowserStateSnapshot = {
  protocolVersion: 1,
  source,
  revision: 4,
  tabs: [{
    id: 1,
    title: 'Example',
    url: 'https://example.test/page',
    active: true,
    viewportRevision: 3,
  }],
};
const capture: BrowserAnnotationCapture = {
  protocolVersion: 1,
  source,
  snapshot,
  tabId: 1,
  url: 'https://example.test/page',
  viewportRevision: 3,
  presentationBounds: { x: 10, y: 100, width: 420, height: 480 },
  cssViewport: { width: 420, height: 480 },
  physicalPixels: { width: 840, height: 960 },
  scroll: { x: 0, y: 0 },
  deviceScaleFactor: 2,
  zoomFactor: 1,
  pngBase64: 'cG5n',
};

function RegisterTarget({ addPng }: { addPng: (file: File) => Promise<boolean> }) {
  const target = useMemo<IabComposerTarget>(() => ({
    key: 'local:session-a', status: 'supported', reason: '', addPng,
  }), [addPng]);
  useRegisterIabComposerTarget(target);
  return null;
}

describe('IabPanel annotation handoff', () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  let currentRect: DOMRect;
  let resizeCallbacks: Array<() => void>;

  beforeEach(() => {
    currentRect = {
      x: 10, y: 100, width: 420, height: 480,
      top: 100, left: 10, right: 430, bottom: 580,
      toJSON: () => ({}),
    } as DOMRect;
    resizeCallbacks = [];
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        const notify = (): void => this.callback(
          [{ target } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
        resizeCallbacks.push(notify);
        notify();
      }
      disconnect(): void {}
      unobserve(): void {}
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => currentRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.ResizeObserver = originalResizeObserver;
    cleanup();
  });

  it('adds the completed PNG only through the registered composer attachment target', async () => {
    const addPng = vi.fn(async (_file: File) => true);
    window.api = {
      beginBrowserPresentation: vi.fn(async () => ({ leaseId: 'lease-a', source, snapshot })),
      updateBrowserPresentation: vi.fn(async (request) => ({
        snapshot, appliedBounds: request.bounds,
      })),
      captureBrowserAnnotation: vi.fn(async () => capture),
      closeBrowserPresentationTab: vi.fn(),
      parkBrowserPresentation: vi.fn(async () => true),
    } as unknown as typeof window.api;
    render(
      <IabComposerBridgeProvider>
        <RegisterTarget addPng={addPng} />
        <IabPanel source={source} snapshot={snapshot} />
      </IabComposerBridgeProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '标注' }));
    await screen.findByTestId('annotation-canvas');
    fireEvent.click(screen.getByRole('button', { name: '完成测试标注' }));

    await waitFor(() => expect(addPng).toHaveBeenCalledOnce());
    expect(addPng.mock.calls[0]?.[0]).toMatchObject({
      name: 'iab-annotation.png', type: 'image/png',
    });
    expect(await screen.findByText(/请在下方补充文字后手动发送/)).toBeTruthy();
  });

  it('hides annotation and explains the live composer limitation in-page', async () => {
    window.api = {
      beginBrowserPresentation: vi.fn(async () => ({ leaseId: 'lease-a', source, snapshot })),
      updateBrowserPresentation: vi.fn(async (request) => ({
        snapshot, appliedBounds: request.bounds,
      })),
      parkBrowserPresentation: vi.fn(async () => true),
    } as unknown as typeof window.api;
    render(
      <IabComposerBridgeProvider fallback={unsupportedIabComposerTarget(
        'local:session-a',
        '当前轮次只支持文字。',
      )}>
        <IabPanel source={source} snapshot={snapshot} />
      </IabComposerBridgeProvider>,
    );

    expect(await screen.findByText('暂不可标注：当前轮次只支持文字。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '标注' })).toBeNull();
  });

  it('invalidates a frozen draft after navigation', async () => {
    const addPng = vi.fn(async (_file: File) => true);
    window.api = {
      beginBrowserPresentation: vi.fn(async () => ({ leaseId: 'lease-a', source, snapshot })),
      updateBrowserPresentation: vi.fn(async (request) => ({
        snapshot, appliedBounds: request.bounds,
      })),
      captureBrowserAnnotation: vi.fn(async () => capture),
      parkBrowserPresentation: vi.fn(async () => true),
    } as unknown as typeof window.api;
    const view = render(
      <IabComposerBridgeProvider>
        <RegisterTarget addPng={addPng} />
        <IabPanel source={source} snapshot={snapshot} />
      </IabComposerBridgeProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '标注' }));
    await screen.findByTestId('annotation-canvas');

    const navigated: BrowserStateSnapshot = {
      ...snapshot,
      revision: 5,
      tabs: [{ ...snapshot.tabs[0]!, url: 'https://example.test/next', viewportRevision: 4 }],
    };
    view.rerender(
      <IabComposerBridgeProvider>
        <RegisterTarget addPng={addPng} />
        <IabPanel source={source} snapshot={navigated} />
      </IabComposerBridgeProvider>,
    );

    expect(await screen.findByText(/页面内容或视口已变化，未完成的标注已取消/)).toBeTruthy();
    expect(screen.queryByTestId('annotation-canvas')).toBeNull();
    expect(addPng).not.toHaveBeenCalled();
  });

  it('invalidates a frozen draft when the responsive panel bounds change', async () => {
    const addPng = vi.fn(async (_file: File) => true);
    window.api = {
      beginBrowserPresentation: vi.fn(async () => ({ leaseId: 'lease-a', source, snapshot })),
      updateBrowserPresentation: vi.fn(async (request) => ({
        snapshot, appliedBounds: request.bounds,
      })),
      captureBrowserAnnotation: vi.fn(async () => capture),
      parkBrowserPresentation: vi.fn(async () => true),
    } as unknown as typeof window.api;
    render(
      <IabComposerBridgeProvider>
        <RegisterTarget addPng={addPng} />
        <IabPanel source={source} snapshot={snapshot} />
      </IabComposerBridgeProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '标注' }));
    await screen.findByTestId('annotation-canvas');

    currentRect = {
      ...currentRect,
      width: 500,
      right: 510,
    } as DOMRect;
    for (const notify of [...resizeCallbacks]) notify();

    expect(await screen.findByText(/IAB 面板尺寸已变化，未完成的标注已取消/)).toBeTruthy();
    expect(screen.queryByTestId('annotation-canvas')).toBeNull();
    expect(addPng).not.toHaveBeenCalled();
  });
});
