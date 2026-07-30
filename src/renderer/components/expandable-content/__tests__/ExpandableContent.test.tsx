// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  ExpandableContent,
  createAuthorizedContentReferenceId,
  type ExpandableContentPayload,
  type MessageContentPayload,
} from '..';

const messageIdentity = {
  sessionId: 'session-1',
  kind: 'message' as const,
  messageId: 'message-1',
};

const messagePayload: MessageContentPayload = {
  kind: 'message',
  text: '完整消息',
  attachments: [],
};

afterEach(() => {
  cleanup();
});

describe('ExpandableContent', () => {
  it('opens a semantic body portal and closes it from the shell control', () => {
    const onOpenChange = vi.fn();
    const view = render(
      <div data-testid="owner">
        <ExpandableContent
          identity={messageIdentity}
          payload={messagePayload}
          title="消息详情"
          actions={<button type="button">表面操作</button>}
          validation={<p>验证结果</p>}
          onOpenChange={onOpenChange}
        >
          {({ payload }) => <p>{payload.text}</p>}
        </ExpandableContent>
      </div>,
    );

    const trigger = screen.getByRole('button', { name: '展开内容' });
    expect(trigger.getAttribute('title')).toBe('展开内容');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.className).toContain('h-11');
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: '消息详情' });
    expect(view.container.contains(dialog)).toBe(false);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.className).toContain('bg-deck-bg-strong');
    expect(dialog.className).not.toContain('bg-[#141418]');
    expect(dialog.querySelector('header')?.className).toContain('px-3');
    expect(dialog.querySelector('header')?.className).toContain('sm:px-4');
    expect(dialog.querySelector('header')?.className).not.toContain('pl-[78px]');
    expect(within(dialog).getByText('完整消息')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '表面操作' })).toBeTruthy();
    expect(within(dialog).getByText('验证结果')).toBeTruthy();

    const close = within(dialog).getByRole('button', { name: '关闭展开内容' });
    expect(close.className).toContain('h-8');
    expect(close.className).toContain('w-8');
    expect(close.querySelector('svg')?.getAttribute('class')).toContain('h-3');
    fireEvent.click(close);
    expect(screen.queryByRole('dialog', { name: '消息详情' })).toBeNull();
    expect(onOpenChange.mock.calls).toEqual([
      [true, messageIdentity],
      [false, messageIdentity],
    ]);
  });

  it('uses a compact trigger for input surfaces without changing the default trigger', () => {
    render(
      <div className="relative">
        <ExpandableContent
          identity={messageIdentity}
          payload={messagePayload}
          title="消息编辑"
          triggerVariant="input"
        >
          <textarea aria-label="消息编辑器" />
        </ExpandableContent>
      </div>,
    );

    const trigger = screen.getByRole('button', { name: '展开内容' });
    expect(trigger.className).toContain('right-1');
    expect(trigger.className).toContain('top-1');
    expect(trigger.className).toContain('h-6');
    expect(trigger.className).toContain('w-6');
    expect(trigger.className).not.toContain('h-11');
    expect(trigger.className).not.toContain('w-11');
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: '消息编辑' });
    expect(dialog.className).toContain('bg-[#141418]');
    expect(dialog.className).not.toContain('bg-deck-bg-strong');
    expect(dialog.querySelector('header')?.className).toContain('pl-[78px]');
    expect(dialog.querySelector('header')?.className).not.toContain('sm:px-4');
  });

  it('lets only the topmost nested layer consume Escape', async () => {
    render(
      <ExpandableContent
        identity={messageIdentity}
        payload={messagePayload}
        title="外层详情"
      >
        <div className="relative">
          <ExpandableContent
            identity={{
              sessionId: 'session-1',
              kind: 'event',
              eventId: 'event-2',
            }}
            payload={{ kind: 'diagnostic', text: '内层内容' }}
            title="内层详情"
            triggerLabel="展开内层"
          >
            <div
              role="dialog"
              aria-label="内层灯箱"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === 'Escape') event.preventDefault();
              }}
            >
              内层内容
            </div>
          </ExpandableContent>
        </div>
      </ExpandableContent>,
    );

    fireEvent.click(screen.getByRole('button', { name: '展开内容' }));
    fireEvent.click(screen.getByRole('button', { name: '展开内层' }));
    expect(screen.getByRole('dialog', { name: '内层详情' })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('dialog', { name: '内层灯箱' }), { key: 'Escape' });
    await Promise.resolve();
    expect(screen.getByRole('dialog', { name: '内层详情' })).toBeTruthy();
    expect(document.querySelectorAll('[data-expandable-content-key]')).toHaveLength(2);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '内层详情' })).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: '外层详情' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '外层详情' })).toBeNull();
    });
  });

  it('focuses the panel predictably, contains Tab, and restores the trigger', () => {
    render(
      <ExpandableContent
        identity={messageIdentity}
        payload={messagePayload}
        title="焦点详情"
      >
        <button type="button">第一个操作</button>
        <button type="button">最后一个操作</button>
      </ExpandableContent>,
    );

    const trigger = screen.getByRole('button', { name: '展开内容' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '焦点详情' });
    expect(document.activeElement).toBe(dialog);

    const close = within(dialog).getByRole('button', { name: '关闭展开内容' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: '第一个操作' }),
    );

    fireEvent.click(close);
    expect(document.activeElement).toBe(trigger);
  });

  it('blocks dirty close unless the caller confirmation allows it', async () => {
    const confirmClose = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onCloseBlocked = vi.fn();
    render(
      <ExpandableContent
        identity={messageIdentity}
        payload={messagePayload}
        title="可编辑内容"
        dirty
        confirmClose={confirmClose}
        onCloseBlocked={onCloseBlocked}
      >
        <textarea aria-label="草稿" defaultValue="未保存" />
      </ExpandableContent>,
    );

    fireEvent.click(screen.getByRole('button', { name: '展开内容' }));
    const close = screen.getByRole('button', { name: '关闭展开内容' });
    fireEvent.click(close);
    await waitFor(() => expect(confirmClose).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog', { name: '可编辑内容' })).toBeTruthy();
    expect(onCloseBlocked).toHaveBeenCalledWith({
      reason: 'close-button',
      cause: 'confirmation-declined',
    });

    fireEvent.click(close);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '可编辑内容' })).toBeNull();
    });
  });

  it('closes on a stable identity switch and never renders the new payload as the old view', () => {
    const { rerender } = render(
      <ExpandableContent
        identity={messageIdentity}
        payload={messagePayload}
        title="选择详情"
      >
        {({ payload }) => <p>{payload.text}</p>}
      </ExpandableContent>,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开内容' }));
    expect(screen.getByText('完整消息')).toBeTruthy();

    const nextIdentity = {
      sessionId: 'session-2',
      kind: 'request' as const,
      requestId: 'request-2',
    };
    rerender(
      <ExpandableContent
        identity={nextIdentity}
        payload={{ kind: 'diagnostic', text: '新选择' }}
        title="选择详情"
      >
        {({ payload }) => <p>{payload.kind === 'diagnostic' ? payload.text : ''}</p>}
      </ExpandableContent>,
    );

    expect(screen.queryByRole('dialog', { name: '选择详情' })).toBeNull();
    expect(screen.queryByText('完整消息')).toBeNull();
    expect(screen.queryByText('新选择')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开内容' }));
    expect(screen.getByText('新选择')).toBeTruthy();
  });

  it('preserves typed payload and authorized references without text flattening', () => {
    const authorization = {
      sessionId: 'session-1',
      grantId: 'grant-1',
      capability: 'read-image' as const,
    };
    const imageReference = {
      kind: 'image' as const,
      referenceId: createAuthorizedContentReferenceId('image-asset-42'),
      authorization,
      mediaType: 'image/png',
      alt: '界面截图',
    };
    const diffReference = {
      kind: 'diff' as const,
      referenceId: createAuthorizedContentReferenceId('diff-asset-9'),
      authorization: {
        ...authorization,
        capability: 'read-diff' as const,
      },
      presentation: 'image-diff' as const,
    };
    const payload: ExpandableContentPayload = {
      kind: 'message',
      text: '消息正文',
      attachments: [
        {
          id: 'attachment-1',
          name: '截图.png',
          mediaType: 'image/png',
          reference: imageReference,
        },
      ],
      relatedReferences: [diffReference],
    };
    const observed: ExpandableContentPayload[] = [];
    render(
      <ExpandableContent
        identity={messageIdentity}
        payload={payload}
        title="载荷详情"
      >
        {({ payload: received }) => {
          observed.push(received);
          return <p>{received.kind}</p>;
        }}
      </ExpandableContent>,
    );

    fireEvent.click(screen.getByRole('button', { name: '展开内容' }));
    const received = observed.at(-1);
    expect(received).toBe(payload);
    if (received?.kind !== 'message') throw new Error('expected message payload');
    expect(received.attachments[0]?.reference).toBe(imageReference);
    expect(received.relatedReferences?.[0]).toBe(diffReference);
    const typedPayloads: readonly ExpandableContentPayload[] = [
      {
        kind: 'tool',
        toolName: 'inspect',
        input: { target: 'opaque-target', options: ['metadata'] },
        result: { status: 'success', value: { matches: 2 } },
      },
      {
        kind: 'plan-review',
        document: { text: '# 计划', format: 'markdown' },
        annotations: [
          {
            id: 'annotation-1',
            text: '需要补充验证',
            start: 0,
            end: 4,
            metadata: { source: 'reviewer' },
          },
        ],
        review: {
          requestId: 'request-1',
          status: 'pending',
          metadata: { round: 1 },
        },
      },
      { kind: 'image', reference: imageReference },
      { kind: 'diff', reference: diffReference },
      {
        kind: 'diagnostic',
        text: '诊断文本',
        severity: 'warning',
        metadata: { source: 'renderer' },
      },
    ];
    expect(typedPayloads.map((item) => item.kind)).toEqual([
      'tool',
      'plan-review',
      'image',
      'diff',
      'diagnostic',
    ]);
    expect(() => createAuthorizedContentReferenceId('/tmp/raw-image.png')).toThrow();
    expect(() => createAuthorizedContentReferenceId('data:image/png;base64,AAAA')).toThrow();
  });

  it('keeps at most one heavy view mounted across nested layers', async () => {
    const lifecycle = vi.fn();
    render(
      <ExpandableContent
        identity={messageIdentity}
        payload={messagePayload}
        title="外层重视图"
        heavyView={{
          id: 'outer-heavy',
          kind: 'monaco',
          render: () => <div>外层 Monaco</div>,
          onLifecycle: lifecycle,
        }}
      >
        <ExpandableContent
          identity={{
            sessionId: 'session-1',
            kind: 'event',
            eventId: 'inner-heavy-event',
          }}
          payload={{ kind: 'diagnostic', text: '图片差异' }}
          title="内层重视图"
          triggerLabel="展开图片差异"
          heavyView={{
            id: 'inner-heavy',
            kind: 'image-diff',
            render: () => <div>内层图片差异</div>,
            onLifecycle: lifecycle,
          }}
        />
      </ExpandableContent>,
    );

    fireEvent.click(screen.getByRole('button', { name: '展开内容' }));
    await screen.findByText('外层 Monaco');
    expect(document.querySelectorAll('[data-expandable-heavy-view]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '展开图片差异' }));
    await screen.findByText('内层图片差异');
    expect(screen.queryByText('外层 Monaco')).toBeNull();
    expect(document.querySelectorAll('[data-expandable-heavy-view]')).toHaveLength(1);
    expect(
      lifecycle.mock.calls
        .map(([event]) => event.mountedCount as number)
        .every((count) => count <= 1),
    ).toBe(true);
  });
});
