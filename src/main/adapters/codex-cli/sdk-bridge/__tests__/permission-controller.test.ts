import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@shared/types';
import { CodexPermissionController } from '../permission-controller';
import type { InternalSession } from '../types';

function makeSession(): InternalSession {
  return {
    applicationSid: 'app-session',
    threadId: 'thread-1',
    intentionallyClosed: false,
    pendingPermissions: new Map(),
  } as InternalSession;
}

function makeController(timeoutMs = 10_000) {
  const events: AgentEvent[] = [];
  return {
    controller: new CodexPermissionController(timeoutMs, (event) => events.push(event)),
    events,
  };
}

describe('CodexPermissionController', () => {
  it('maps a native command approval to allow-once and allow-for-session decisions', async () => {
    const active = makeSession();
    const { controller } = makeController();
    const request = {
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        command: 'pnpm test',
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      },
    };

    const once = controller.handle(active, request, new AbortController().signal);
    const [onceRequest] = controller.list(active);
    expect(onceRequest).toMatchObject({
      type: 'permission-request',
      toolName: 'Codex command',
      toolInput: { command: 'pnpm test' },
      suggestions: { scope: 'session' },
    });
    controller.respond(active, onceRequest.requestId, { decision: 'allow' });
    await expect(Promise.resolve(once)).resolves.toEqual({
      handled: true,
      result: { decision: 'accept' },
    });

    const always = controller.handle(active, { ...request, id: 2 }, new AbortController().signal);
    const [alwaysRequest] = controller.list(active);
    controller.respond(active, alwaysRequest.requestId, {
      decision: 'allow',
      updatedPermissions: alwaysRequest.suggestions,
    });
    await expect(Promise.resolve(always)).resolves.toEqual({
      handled: true,
      result: { decision: 'acceptForSession' },
    });
  });

  it('does not invent command decisions when app-server provides an explicit empty list', async () => {
    const active = makeSession();
    const { controller } = makeController();
    const aborter = new AbortController();
    const pending = controller.handle(
      active,
      {
        id: 'empty-decisions',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          availableDecisions: [],
        },
      },
      aborter.signal,
    );
    const [request] = controller.list(active);

    expect(request.suggestions).toBeUndefined();
    aborter.abort();
    await expect(Promise.resolve(pending)).resolves.toEqual({
      handled: true,
      result: { decision: 'cancel' },
    });
  });

  it('grants only the exact permission profile returned by app-server', async () => {
    const active = makeSession();
    const { controller } = makeController();
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: null, write: ['/shared'] },
    };
    const pending = controller.handle(
      active,
      {
        id: 'permission-1',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          permissions,
        },
      },
      new AbortController().signal,
    );
    const [request] = controller.list(active);

    controller.respond(active, request.requestId, {
      decision: 'allow',
      updatedPermissions: request.suggestions,
    });

    await expect(Promise.resolve(pending)).resolves.toEqual({
      handled: true,
      result: { permissions, scope: 'session' },
    });
  });

  it('maps legacy denial and timeout to the exact app-server response vocabulary', async () => {
    const active = makeSession();
    const { controller } = makeController();
    const denial = controller.handle(
      active,
      {
        id: 3,
        method: 'execCommandApproval',
        params: { conversationId: 'thread-1', command: ['git', 'push'] },
      },
      new AbortController().signal,
    );
    const [denialRequest] = controller.list(active);
    controller.respond(active, denialRequest.requestId, {
      decision: 'deny',
      message: 'Not approved',
    });
    await expect(Promise.resolve(denial)).resolves.toEqual({
      handled: true,
      result: { decision: { denied: { rejection: 'Not approved' } } },
    });

    const timeout = controller.handle(
      active,
      {
        id: 4,
        method: 'applyPatchApproval',
        params: { conversationId: 'thread-1', fileChanges: {} },
      },
      new AbortController().signal,
    );
    controller.cancel(active, 'timed-out');
    await expect(Promise.resolve(timeout)).resolves.toEqual({
      handled: true,
      result: { decision: 'timed_out' },
    });
  });

  it('cancels a pending request when app-server resolves it elsewhere', async () => {
    const active = makeSession();
    const { controller, events } = makeController();
    const aborter = new AbortController();
    const pending = controller.handle(
      active,
      {
        id: 5,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
      },
      aborter.signal,
    );
    const [request] = controller.list(active);

    aborter.abort();

    await expect(Promise.resolve(pending)).resolves.toEqual({
      handled: true,
      result: { decision: 'cancel' },
    });
    expect(controller.list(active)).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      sessionId: 'app-session',
      kind: 'waiting-for-user',
      payload: { type: 'permission-cancelled', requestId: request.requestId },
    }));
  });

  it('leaves non-approval server requests to the app-server transport fallback', () => {
    const active = makeSession();
    const { controller } = makeController();
    expect(controller.handle(
      active,
      { id: 6, method: 'item/tool/requestUserInput', params: {} },
      new AbortController().signal,
    )).toEqual({ handled: false });
    expect(controller.list(active)).toEqual([]);
  });
});
