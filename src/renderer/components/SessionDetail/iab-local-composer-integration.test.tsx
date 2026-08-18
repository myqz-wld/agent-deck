// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRecord } from '@shared/types';
import { resetImageAttachmentSidecarForTests } from '@renderer/hooks/image-attachments/payload-sidecar';
import { useSessionStore } from '@renderer/stores/session-store';
import { ComposerSdk } from './ComposerSdk';
import { IabComposerBridgeProvider, useIabComposerTarget } from './iab-composer-bridge';

function session(): SessionRecord {
  return {
    id: 'local-session',
    agentId: 'codex-cli',
    cwd: '/tmp/project',
    title: 'Codex',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
  };
}

function AttachmentProbe() {
  const target = useIabComposerTarget();
  return (
    <button
      type="button"
      disabled={target.status !== 'supported' || target.addPng == null}
      onClick={() => void target.addPng?.(new File(['png'], 'iab-annotation.png', {
        type: 'image/png',
      }))}
    >
      加入本地 IAB PNG
    </button>
  );
}

describe('Local IAB composer attachment bridge', () => {
  const OriginalImage = globalThis.Image;
  const sendAdapterMessage = vi.fn(async () => undefined);

  beforeEach(() => {
    sendAdapterMessage.mockClear();
    resetImageAttachmentSidecarForTests();
    useSessionStore.setState({
      sessions: new Map(),
      composerBySession: new Map(),
      composerAliases: new Map(),
      composerRequestSequence: 0,
    });
    class FailedImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    }
    globalThis.Image = FailedImage as unknown as typeof Image;
    window.api = {
      listAdapters: vi.fn().mockResolvedValue([{
        id: 'codex-cli',
        displayName: 'Codex CLI',
        capabilities: { canAcceptAttachments: true },
      }]),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexGatewayProfiles: vi.fn().mockResolvedValue([]),
      listPendingOutgoingMessages: vi.fn().mockResolvedValue([]),
      onAgentEvent: vi.fn(() => () => undefined),
      sendAdapterMessage,
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    cleanup();
    globalThis.Image = OriginalImage;
    Reflect.deleteProperty(window, 'api');
  });

  it('uses the exact Local composer attachment state and leaves Send untouched', async () => {
    render(
      <IabComposerBridgeProvider>
        <ComposerSdk session={session()} />
        <AttachmentProbe />
      </IabComposerBridgeProvider>,
    );
    const add = screen.getByRole('button', { name: '加入本地 IAB PNG' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);

    expect(await screen.findByAltText('iab-annotation.png')).toBeTruthy();
    expect(sendAdapterMessage).not.toHaveBeenCalled();
  });
});
