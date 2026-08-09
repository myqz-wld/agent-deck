// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@shared/types';
import { ActivityRecordsView } from './records-view';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('ActivityRecordsView source boundaries', () => {
  it('shows an initial load error instead of a permanent loading state', () => {
    render(<ActivityRecordsView events={[]} loaded={false} loadError="events unavailable"
      sessionId="remote-session" agentId="codex-cli" isSdk />);
    expect(screen.getByText('events unavailable')).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });

  it('shows a refresh warning while retaining the last activity records', () => {
    const event: AgentEvent = {
      sessionId: 'remote-session', agentId: 'codex-cli', kind: 'message',
      payload: { role: 'assistant', text: 'last known event' }, ts: 1,
    };
    render(<ActivityRecordsView events={[event]} loaded loadError="events refresh failed"
      sessionId="remote-session" agentId="codex-cli" isSdk />);
    expect(screen.getByRole('alert').textContent).toContain('events refresh failed');
    expect(screen.getByText('last known event')).toBeTruthy();
  });

  it('reuses event rows without invoking Local asset IPC for Remote records', () => {
    const loadUploadedImage = vi.fn();
    const loadImageBlob = vi.fn();
    window.api = { loadUploadedImage, loadImageBlob } as unknown as typeof window.api;
    const events: AgentEvent[] = [{
      sessionId: 'remote-session',
      agentId: 'codex-cli',
      kind: 'message',
      payload: {
        role: 'user',
        text: '带远程附件的消息',
        attachments: [{
          kind: 'uploaded', path: 'Workspace/image.png', mime: 'image/png', bytes: 12,
        }],
      },
      ts: 1,
    }, {
      sessionId: 'remote-session',
      agentId: 'codex-cli',
      kind: 'tool-use-start',
      payload: {
        toolUseId: 'image-1',
        toolName: 'mcp__agent-deck-image__ImageRead',
        toolInput: { file_path: 'Workspace/image.png' },
      },
      ts: 2,
    }, {
      sessionId: 'remote-session',
      agentId: 'codex-cli',
      kind: 'tool-use-end',
      payload: {
        toolUseId: 'image-1',
        toolName: 'ImageRead',
        toolResult: JSON.stringify({
          kind: 'image-read',
          file: 'Workspace/image.png',
          description: '远程图片描述',
        }),
      },
      ts: 3,
    }];
    render(<ActivityRecordsView events={events} loaded loadError={null}
      sessionId="remote-session" agentId="codex-cli" isSdk
      allowLocalAssets={false} interactivePending={false} />);
    expect(screen.getByText('带远程附件的消息')).toBeTruthy();
    expect(screen.getByText('远程图片需通过资产通道读取')).toBeTruthy();
    expect(loadUploadedImage).not.toHaveBeenCalled();
    expect(loadImageBlob).not.toHaveBeenCalled();
  });

  it('renders Remote approval events read-only instead of routing to Local responders', () => {
    const resolvePermission = vi.fn();
    const event: AgentEvent = {
      sessionId: 'remote-session',
      agentId: 'codex-cli',
      kind: 'waiting-for-user',
      payload: {
        type: 'permission-request', requestId: 'request-a', toolName: 'Bash',
      },
      ts: 1,
    };
    render(<ActivityRecordsView events={[event]} loaded loadError={null}
      sessionId="remote-session" agentId="codex-cli" isSdk
      interactivePending={false} resolvePermission={resolvePermission} />);
    expect(screen.getByText(/等待你授权 Bash/)).toBeTruthy();
    expect(resolvePermission).not.toHaveBeenCalled();
  });
});
