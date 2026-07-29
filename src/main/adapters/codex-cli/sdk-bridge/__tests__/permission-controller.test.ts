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
      toolName: 'Codex CLI 命令',
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
    expect(request.toolName).toBe('Codex CLI 权限授权');

    controller.respond(active, request.requestId, {
      decision: 'allow',
      updatedPermissions: request.suggestions,
    });

    await expect(Promise.resolve(pending)).resolves.toEqual({
      handled: true,
      result: { permissions, scope: 'session' },
    });
  });

  it('routes MCP requestUserInput approvals through the permission queue', async () => {
    const active = makeSession();
    const { controller } = makeController();
    const question = {
      id: 'mcp_tool_call_approval_call-1',
      header: 'Approve app tool call?',
      question: 'Allow the agent-deck MCP server to run tool "shutdown_session"?',
      isOther: false,
      isSecret: false,
      options: [
        { label: 'Allow', description: 'Run the tool and continue.' },
        {
          label: 'Allow for this session',
          description: 'Run the tool and remember this choice for this session.',
        },
        { label: 'Cancel', description: 'Cancel this tool call.' },
      ],
    };
    const request = {
      id: 'mcp-approval-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'call-1',
        questions: [question],
        autoResolutionMs: null,
      },
    };

    const once = controller.handle(active, request, new AbortController().signal);
    const [onceRequest] = controller.list(active);
    expect(onceRequest).toMatchObject({
      type: 'permission-request',
      toolName: 'Codex CLI MCP 工具调用',
      toolInput: {
        itemId: 'call-1',
        questions: [{
          header: 'Approve app tool call?',
          question: 'Allow the agent-deck MCP server to run tool "shutdown_session"?',
        }],
      },
      suggestions: { scope: 'session' },
    });
    controller.respond(active, onceRequest.requestId, { decision: 'allow' });
    await expect(Promise.resolve(once)).resolves.toEqual({
      handled: true,
      result: {
        answers: {
          [question.id]: { answers: ['Allow'] },
        },
      },
    });

    const session = controller.handle(
      active,
      { ...request, id: 'mcp-approval-2' },
      new AbortController().signal,
    );
    const [sessionRequest] = controller.list(active);
    controller.respond(active, sessionRequest.requestId, {
      decision: 'allow',
      updatedPermissions: sessionRequest.suggestions,
    });
    await expect(Promise.resolve(session)).resolves.toEqual({
      handled: true,
      result: {
        answers: {
          [question.id]: { answers: ['Allow for this session'] },
        },
      },
    });

    const denied = controller.handle(
      active,
      { ...request, id: 'mcp-approval-3' },
      new AbortController().signal,
    );
    const [deniedRequest] = controller.list(active);
    controller.respond(active, deniedRequest.requestId, { decision: 'deny' });
    await expect(Promise.resolve(denied)).resolves.toEqual({
      handled: true,
      result: {
        answers: {
          [question.id]: { answers: ['__codex_mcp_decline__'] },
        },
      },
    });

    const aborter = new AbortController();
    const cancelled = controller.handle(
      active,
      { ...request, id: 'mcp-approval-4' },
      aborter.signal,
    );
    aborter.abort();
    await expect(Promise.resolve(cancelled)).resolves.toEqual({
      handled: true,
      result: { answers: {} },
    });
  });

  it('routes MCP approval elicitations and preserves session-scoped approval', async () => {
    const active = makeSession();
    const { controller } = makeController();
    const request = {
      id: 'mcp-elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'agent-deck',
        mode: 'form',
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          persist: ['session', 'always'],
          tool_name: 'hand_off_session',
        },
        message: 'Allow the agent-deck MCP server to run tool "hand_off_session"?',
        requestedSchema: { type: 'object', properties: {} },
      },
    };

    const pending = controller.handle(active, request, new AbortController().signal);
    const [permission] = controller.list(active);
    expect(permission).toMatchObject({
      toolName: 'Codex CLI MCP 工具调用',
      toolInput: {
        serverName: 'agent-deck',
        message: 'Allow the agent-deck MCP server to run tool "hand_off_session"?',
      },
      suggestions: { scope: 'session' },
    });
    controller.respond(active, permission.requestId, {
      decision: 'allow',
      updatedPermissions: permission.suggestions,
    });

    await expect(Promise.resolve(pending)).resolves.toEqual({
      handled: true,
      result: {
        action: 'accept',
        content: null,
        _meta: { persist: 'session' },
      },
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
    expect(denialRequest.toolName).toBe('Codex CLI 命令');
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
    const [timeoutRequest] = controller.list(active);
    expect(timeoutRequest.toolName).toBe('Codex CLI 文件修改');
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
    expect(request.toolName).toBe('Codex CLI 文件修改');

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
    expect(controller.handle(
      active,
      {
        id: 7,
        method: 'mcpServer/elicitation/request',
        params: {
          mode: 'form',
          _meta: { purpose: 'collect-project-name' },
          message: 'Project name?',
        },
      },
      new AbortController().signal,
    )).toEqual({ handled: false });
    expect(controller.list(active)).toEqual([]);
  });
});
