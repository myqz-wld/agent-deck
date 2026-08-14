import { describe, expect, it } from 'vitest';
import { createPermissionPreviewDisplay } from '@contracts/index';
import { resolveGatewayLimits } from './gateway-config';
import {
  validateHistoryResult,
  validatePendingListResult,
  validatePendingRespondResult,
  validateRuntimeControls,
  validateRuntimeUpdateResult,
  validateSendResult,
  validateSubscriptionResult,
} from './core-output';

const limits = resolveGatewayLimits(undefined);
const sessionId = 'session-1';

const cases = [
  {
    name: 'history',
    valid: {
      entries: [{
        id: 'history-1', sessionId, sequence: 1, role: 'assistant', content: 'ok', createdAt: 1,
      }],
      nextCursor: null,
      revision: 2,
    },
    validate: (value: unknown) => validateHistoryResult(value, sessionId, limits),
  },
  {
    name: 'pending.list',
    valid: {
      requests: [{
        id: 'pending-1', sessionId, kind: 'permission', status: 'pending', createdAt: 1,
        expiresAt: null, display: createPermissionPreviewDisplay('Bash', { command: 'pwd' }),
      }],
      revision: 2,
    },
    validate: (value: unknown) => validatePendingListResult(value, sessionId, limits),
  },
  {
    name: 'session.send',
    valid: { messageId: 'message-1', sequence: 1, revision: 2 },
    validate: (value: unknown) => validateSendResult(value, limits),
  },
  {
    name: 'session.runtime.get',
    valid: { adapterId: 'codex-cli', values: { approvalPolicy: 'never' }, revision: 2 },
    validate: (value: unknown) => validateRuntimeControls(value, limits),
  },
  {
    name: 'session.runtime.update',
    valid: {
      controls: { adapterId: 'codex-cli', values: { approvalPolicy: 'never' }, revision: 2 },
      effect: 'hot-applied',
      replacementSessionId: null,
    },
    validate: (value: unknown) => validateRuntimeUpdateResult(value, limits),
  },
  {
    name: 'subscription.set',
    valid: { subscribed: true, revision: 2 },
    validate: (value: unknown) => validateSubscriptionResult(value, limits),
  },
  {
    name: 'pending.respond',
    valid: { status: 'resolved', revision: 2 },
    validate: (value: unknown) => validatePendingRespondResult(value, limits),
  },
] as const;

describe('complete Core response wrapper contracts', () => {
  for (const entry of cases) {
    it(`accepts only the exact bounded ${entry.name} wrapper`, () => {
      expect(() => entry.validate(structuredClone(entry.valid))).not.toThrow();
      expect(() => entry.validate({ ...entry.valid, unexpected: true })).toThrowError(
        expect.objectContaining({ code: 'invalid_core_response' }),
      );
      const small = resolveGatewayLimits({
        maxCoreResponseBytes: 128,
        maxCoreFieldBytes: 512,
      });
      const validateOversized = entry.name === 'history'
        ? (value: unknown) => validateHistoryResult(value, sessionId, small)
        : entry.name === 'pending.list'
          ? (value: unknown) => validatePendingListResult(value, sessionId, small)
          : entry.name === 'session.send'
            ? (value: unknown) => validateSendResult(value, small)
            : entry.name === 'session.runtime.get'
              ? (value: unknown) => validateRuntimeControls(value, small)
              : entry.name === 'session.runtime.update'
                ? (value: unknown) => validateRuntimeUpdateResult(value, small)
                : entry.name === 'subscription.set'
                  ? (value: unknown) => validateSubscriptionResult(value, small)
                  : (value: unknown) => validatePendingRespondResult(value, small);
      expect(() => validateOversized({ ...entry.valid, unused: 'x'.repeat(256) })).toThrowError(
        /over-limit or malformed/,
      );
    });
  }
});
