import { describe, expect, it } from 'vitest';
import { createPermissionPreviewDisplay, type JsonObject, type JsonValue } from '@contracts/index';
import { validatePendingListResult, validatePendingRequests, validateRuntimeControls } from './core-output';
import { resolveGatewayLimits } from './gateway-config';
import {
  actionEvent, actionFrom, credential, flush, messageEvent, onlyClient, pending, select, setup,
} from './__tests__/fixture';

const limits = resolveGatewayLimits(undefined);
const sessionId = 'session-1';

function nativeRequest() {
  const params = {
    requestId: 'connection-check', expectedSettingsRevision: 3,
    title: '连接验证', initialMessage: '只回复连接正常。',
    selection: { adapterId: 'codex-cli', model: 'example-model', thinking: 'medium' },
  };
  return { ...pending(), display: createPermissionPreviewDisplay('Codex CLI MCP 工具调用', {
    serverName: 'agent-deck', message: 'Allow create_work_session?',
    _meta: {
      codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'],
      tool_description: 'Create a work session.', tool_params: params,
      tool_params_display: Object.entries(params).map(([name, value]) => ({
        name, display_name: name, value,
      })),
    },
  }) };
}

function nested(depth: number): JsonObject {
  let value: JsonValue = 'leaf';
  for (let index = 0; index < depth; index++) value = { child: value };
  return value as JsonObject;
}

describe('native MCP approval payload depth', () => {
  it('accepts structured native parameter displays without rewriting the signed input', () => {
    const request = nativeRequest();
    expect(request.display.complete).toBe(true);
    const result = { requests: [request], revision: 10 };
    expect(validatePendingListResult(result, sessionId, limits)).toEqual(result);
    expect(validatePendingRequests(result.requests, sessionId, limits)).toEqual(result.requests);
  });

  it('counts the configured input depth independently of the pending-list envelope', () => {
    for (const depth of [2, limits.maxCoreJsonDepth]) {
      const configured = resolveGatewayLimits({ maxCoreJsonDepth: depth });
      const display = createPermissionPreviewDisplay('Example', nested(depth));
      const result = { requests: [{ ...pending(), display }], revision: 10 };
      expect(display.complete).toBe(true);
      expect(() => validatePendingListResult(result, sessionId, configured)).not.toThrow();
      display.input = nested(depth + 1);
      expect(() => validatePendingListResult(result, sessionId, configured))
        .toThrowError(expect.objectContaining({ code: 'invalid_core_response' }));
      expect(() => validatePendingRequests(result.requests, sessionId, configured))
        .toThrowError(expect.objectContaining({ code: 'invalid_core_response' }));
    }
  });

  it.each([
    { maxCoreResponseBytes: 512 }, { maxCoreFieldBytes: 8 },
    { maxCoreJsonEntries: 8 }, { maxPendingResults: 1 },
  ])('retains the other Core limits: %j', overrides => {
    const result = { requests: [nativeRequest(), nativeRequest()], revision: 10 };
    expect(() => validatePendingListResult(result, sessionId, resolveGatewayLimits(overrides)))
      .toThrowError(expect.objectContaining({ code: 'invalid_core_response' }));
  });

  it('does not relax depth for unrelated Core results or accept malformed permission displays', () => {
    expect(() => validateRuntimeControls({ adapterId: 'codex-cli', revision: 1,
      values: nested(limits.maxCoreJsonDepth) }, limits)).toThrow();
    for (const display of [
      { ...nativeRequest().display, unexpected: nested(8) },
      { ...nativeRequest().display, input: { invalid: '\u0000' } },
      { ...nativeRequest().display, input: new Date() },
    ]) {
      expect(() => validatePendingListResult({ requests: [{ ...pending(), display }], revision: 1 },
        sessionId, limits)).toThrow();
    }
  });

  it.each([false, true])('delivers a native approval and binds its nested parameters; changed=%s', async changed => {
    const test = setup();
    try {
      await select(test.gateway);
      await test.gateway.handle(messageEvent('subscribe-native', '/subscribe'));
      const client = onlyClient(test.clients);
      const request = nativeRequest();
      client.pending.set(sessionId, [request]);
      test.transport.messages.length = 0;
      client.emit({ instanceId: credential.instanceId, revision: 100,
        kind: 'event.persisted', entityId: sessionId,
        payload: { eventId: 17, kind: 'waiting-for-user', adapterId: 'codex-cli', timestamp: 1 },
      });
      await flush(); await flush();
      expect(test.transport.messages).toHaveLength(1);
      const message = test.transport.messages[0];
      const action = actionFrom(message);
      expect(test.store.getDelivery(credential.instanceId, message.eventId)?.status).toBe('sent');
      expect(client.calls.some(call => call.method === 'pending.respond')).toBe(false);
      if (changed) {
        const meta = request.display.input as JsonObject;
        ((meta._meta as JsonObject).tool_params as JsonObject).selection = { adapterId: 'claude-code' };
      }
      const result = await test.gateway.handle(actionEvent('approve-native', action));
      expect(result.code).toBe(changed ? 'pending_context_changed' : 'accepted');
      expect(client.calls.filter(call => call.method === 'pending.respond')).toHaveLength(changed ? 0 : 1);
    } finally { await test.gateway.close(); }
  });
});
