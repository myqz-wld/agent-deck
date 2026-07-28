// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AssetMeta } from '@shared/types';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@renderer/utils/logger', () => ({
  default: { scope: () => loggerSpies },
}));

import { AssetsTab } from './AssetsTab';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  loggerSpies.error.mockReset();
});

const asset: AssetMeta = {
  kind: 'skill',
  source: 'user',
  adapter: 'codex-cli',
  origin: 'direct',
  name: 'careful-reader',
  qualifiedName: 'careful-reader',
  description: '读取文本但不改写',
  absPath: '/workspace/.codex/skills/careful-reader/SKILL.md',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('B18 asset content expansion', () => {
  it('reads the exact text lazily through the existing asset boundary', async () => {
    const body = '---\nname: careful-reader\n---\n\n用户维护正文  \n';
    const getAssetContent = vi.fn().mockResolvedValue({
      ok: true,
      content: body,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getAssetContent },
    });
    const onView = vi.fn();

    render(
      <div style={{ width: 220 }}>
        <AssetsTab
          kind="skill"
          adapter="codex-cli"
          bundled={[]}
          user={[asset]}
          onView={onView}
        />
      </div>,
    );

    expect(getAssetContent).not.toHaveBeenCalled();
    const trigger = screen.getByRole('button', {
      name: '展开查看 careful-reader 完整内容',
    });
    expect(trigger.className).toContain('h-11');
    expect(trigger.className).toContain('w-11');
    trigger.focus();
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(getAssetContent).toHaveBeenCalledWith(
        asset.kind,
        asset.name,
        asset.source,
        asset.adapter,
        asset.absPath,
      );
    });
    const dialog = screen.getByRole('dialog', {
      name: 'careful-reader 完整内容',
    });
    expect(dialog.querySelector('pre')?.textContent).toBe(body);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'careful-reader 完整内容' })).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onView).toHaveBeenCalledWith(asset);
  });

  it('fences a closed read, releases its content, and reloads from empty state', async () => {
    const stale = deferred<{ ok: true; content: string }>();
    const fresh = deferred<{ ok: true; content: string }>();
    const reopened = deferred<{ ok: true; content: string }>();
    const getAssetContent = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise)
      .mockImplementationOnce(() => reopened.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getAssetContent },
    });

    render(
      <AssetsTab
        kind="skill"
        adapter="codex-cli"
        bundled={[]}
        user={[asset]}
        onView={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', {
      name: '展开查看 careful-reader 完整内容',
    });

    fireEvent.click(trigger);
    expect(screen.getByText('正在读取完整内容…')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(trigger);
    expect(screen.getByText('正在读取完整内容…')).toBeTruthy();
    expect(getAssetContent).toHaveBeenCalledTimes(2);

    await act(async () => {
      stale.resolve({ ok: true, content: 'STALE_CONTENT_SECRET' });
    });
    expect(screen.getByText('正在读取完整内容…')).toBeTruthy();
    expect(document.body.textContent).not.toContain('STALE_CONTENT_SECRET');

    await act(async () => {
      fresh.resolve({ ok: true, content: 'FRESH_CONTENT' });
    });
    expect(screen.getByText('FRESH_CONTENT')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain('FRESH_CONTENT');

    fireEvent.click(trigger);
    expect(screen.getByText('正在读取完整内容…')).toBeTruthy();
    expect(document.body.textContent).not.toContain('FRESH_CONTENT');
    expect(getAssetContent).toHaveBeenCalledTimes(3);
    await act(async () => {
      reopened.resolve({ ok: true, content: 'REOPENED_CONTENT' });
    });
    expect(screen.getByText('REOPENED_CONTENT')).toBeTruthy();
  });

  it('uses fixed asset errors and logs no backend reason, path, or content', async () => {
    const backendMarker = 'BACKEND_REASON_SECRET raw-marker /private/backend-path';
    const thrownMarker = 'THROWN_SECRET raw-marker /private/thrown-path';
    const pathMarker = '/private/ASSET_PATH_MARKER/SKILL.md';
    const sensitiveAsset = { ...asset, absPath: pathMarker };
    const reopened = deferred<{ ok: true; content: string }>();
    const getAssetContent = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: backendMarker })
      .mockRejectedValueOnce(new Error(thrownMarker))
      .mockImplementationOnce(() => reopened.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getAssetContent },
    });

    render(
      <AssetsTab
        kind="skill"
        adapter="codex-cli"
        bundled={[]}
        user={[sensitiveAsset]}
        onView={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', {
      name: '展开查看 careful-reader 完整内容',
    }));

    expect(await screen.findByText('读取失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(backendMarker);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(getAssetContent).toHaveBeenCalledTimes(2));
    expect(screen.getByText('读取失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(thrownMarker);

    expect(loggerSpies.error).toHaveBeenCalledTimes(2);
    expect(loggerSpies.error.mock.calls.map(([, fields]) => fields)).toEqual([
      {
        action: 'read',
        adapter: 'codex-cli',
        assetKind: 'skill',
        assetSource: 'user',
        category: 'backend-rejected',
      },
      {
        action: 'read',
        adapter: 'codex-cli',
        assetKind: 'skill',
        assetSource: 'user',
        category: 'request-rejected',
        errorKind: 'object',
      },
    ]);
    const logs = JSON.stringify(loggerSpies.error.mock.calls);
    for (const sensitive of [backendMarker, thrownMarker, pathMarker]) {
      expect(logs).not.toContain(sensitive);
    }

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', {
      name: '展开查看 careful-reader 完整内容',
    }));
    expect(screen.getByText('正在读取完整内容…')).toBeTruthy();
    expect(screen.queryByText('读取失败，请稍后重试。')).toBeNull();
    expect(getAssetContent).toHaveBeenCalledTimes(3);
    await act(async () => {
      reopened.resolve({ ok: true, content: 'RECOVERED_CONTENT' });
    });
    expect(screen.getByText('RECOVERED_CONTENT')).toBeTruthy();
  });
});
