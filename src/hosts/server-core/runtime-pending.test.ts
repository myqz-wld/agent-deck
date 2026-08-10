import { describe, expect, it, vi } from 'vitest';

import { parsePermissionPreviewDisplay } from '@contracts/index';
import type { AgentAdapter } from '@main/adapters/types';
import {
  listServerCorePendingRequests,
  respondToServerCorePending,
} from './runtime-pending';

describe('Server Core provider pending projection', () => {
  it('projects a bounded, redacted authorization preview and blocks incomplete approval', async () => {
    const respondPermission = vi.fn(async () => undefined);
    const permission = {
      type: 'permission-request' as const,
      requestId: 'permission-edit',
      toolName: 'Edit',
      toolInput: {
        file_path: '/workspace/src/app.ts', old_string: 'before', new_string: 'after',
        arguments: {
          endpoint: 'https://example.test',
          token: 'raw-token', client_secret: 'raw-client-secret',
          x_api_key: 'raw-x-api-key', credential: 'raw-credential',
          github_token: 'raw-github-token', auth_token: 'raw-auth-token',
        },
      },
    };
    const adapter = {
      listPending: () => ({
        permissions: [permission], askQuestions: [], exitPlanModes: [],
      }),
      respondPermission,
    } as unknown as AgentAdapter;
    const presentations = { list: () => [], respond: () => null };
    const listed = listServerCorePendingRequests(adapter, 'session-a', 1, presentations);
    const preview = parsePermissionPreviewDisplay(listed[0]!.display);
    expect(preview).toMatchObject({
      complete: true,
      input: {
        file_path: '/workspace/src/app.ts', old_string: 'before', new_string: 'after',
        arguments: {
          endpoint: 'https://example.test',
          token: '[redacted]', client_secret: '[redacted]',
          x_api_key: '[redacted]', credential: '[redacted]',
          github_token: '[redacted]', auth_token: '[redacted]',
        },
      },
    });
    expect(JSON.stringify(preview)).not.toContain('raw-');

    const incomplete = {
      ...permission,
      requestId: 'permission-large',
      toolName: 'Write',
      toolInput: { file_path: '/workspace/large.txt', content: 'x'.repeat(100_000) },
    };
    const limited = {
      ...adapter,
      listPending: () => ({
        permissions: [incomplete], askQuestions: [], exitPlanModes: [],
      }),
    } as unknown as AgentAdapter;
    await expect(respondToServerCorePending(limited, {
      sessionId: 'session-a', requestId: incomplete.requestId, action: 'approve',
    }, presentations)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(respondToServerCorePending(limited, {
      sessionId: 'session-a', requestId: incomplete.requestId, action: 'deny',
    }, presentations)).resolves.toBe('denied');
  });

  it('maps bounded Remote question labels back to the Provider value', async () => {
    const respondAskUserQuestion = vi.fn(async () => undefined);
    const originalLabel = `production-${'x'.repeat(300)}`;
    const adapter = {
      listPending: () => ({
        permissions: [],
        askQuestions: [{
          type: 'ask-user-question',
          requestId: 'ask-long-label',
          questions: [{
            question: 'Environment?',
            multiSelect: false,
            options: [{ label: originalLabel }],
          }],
        }],
        exitPlanModes: [],
      }),
      respondAskUserQuestion,
    } as unknown as AgentAdapter;
    const presentations = { list: () => [], respond: () => null };
    const listed = listServerCorePendingRequests(adapter, 'session-a', 1, presentations);
    const display = listed[0]!.display as {
      questions: Array<{ options: Array<{ label: string }> }>;
    };
    const displayedLabel = display.questions[0]!.options[0]!.label;
    expect(Buffer.byteLength(displayedLabel, 'utf8')).toBeLessThanOrEqual(256);

    await respondToServerCorePending(adapter, {
      sessionId: 'session-a', requestId: 'ask-long-label', action: 'submit',
      value: { q1: [displayedLabel] },
    }, presentations);
    expect(respondAskUserQuestion).toHaveBeenCalledWith('session-a', 'ask-long-label', {
      answers: [{ question: 'Environment?', selected: [originalLabel] }],
    });
  });
});
