import { describe, expect, it, vi } from 'vitest';
import {
  adoptClaudeStreamFirstIdCore,
  type ClaudeStreamSessionIdentityHost,
} from './stream-session-identity-core';
import { makeInternalSession } from './types';

function host(): ClaudeStreamSessionIdentityHost & {
  warn: ReturnType<typeof vi.fn>;
  renameSdkSession: ReturnType<typeof vi.fn>;
  updateCliSessionId: ReturnType<typeof vi.fn>;
} {
  return {
    warn: vi.fn(),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
  };
}

describe('Claude stream first-id Core', () => {
  it('moves a new spawn from its temporary identity to the first provider id', () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'temp-sid' });
    const sessions = new Map([['temp-sid', internal]]);
    const ports = host();
    const onFirstId = vi.fn();

    const result = adoptClaudeStreamFirstIdCore({
      sessions,
      internal,
      tempKey: 'temp-sid',
      incomingId: 'provider-sid',
      onFirstId,
    }, ports);

    expect(result).toBe('provider-sid');
    expect(internal.applicationSid).toBe('provider-sid');
    expect(internal.cliSessionId).toBe('provider-sid');
    expect(sessions.has('temp-sid')).toBe(false);
    expect(sessions.get('provider-sid')).toBe(internal);
    expect(ports.renameSdkSession).toHaveBeenCalledWith('temp-sid', 'provider-sid');
    expect(ports.updateCliSessionId).not.toHaveBeenCalled();
    expect(onFirstId).toHaveBeenCalledWith('provider-sid');
  });

  it('updates only the CLI identity when a normal resume forks', () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'application-sid' });
    const sessions = new Map([['application-sid', internal]]);
    const ports = host();
    const onFirstId = vi.fn();

    const result = adoptClaudeStreamFirstIdCore({
      sessions,
      internal,
      tempKey: 'temp-sid',
      incomingId: 'forked-cli-sid',
      applicationResumeId: 'application-sid',
      effectiveResumeCliSid: 'old-cli-sid',
      onFirstId,
    }, ports);

    expect(result).toBe('forked-cli-sid');
    expect(internal.applicationSid).toBe('application-sid');
    expect(internal.cliSessionId).toBe('forked-cli-sid');
    expect(ports.renameSdkSession).not.toHaveBeenCalled();
    expect(ports.updateCliSessionId).toHaveBeenCalledWith(
      'application-sid',
      'forked-cli-sid',
    );
    expect(onFirstId).toHaveBeenCalledWith('forked-cli-sid');
  });

  it('keeps the application id when a resume reports a phantom runtime id', () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'application-sid' });
    const ports = host();
    const onFirstId = vi.fn();

    const result = adoptClaudeStreamFirstIdCore({
      sessions: new Map([['application-sid', internal]]),
      internal,
      tempKey: 'temp-sid',
      incomingId: 'runtime-only-sid',
      applicationResumeId: 'application-sid',
      effectiveResumeCliSid: 'application-sid',
      onFirstId,
    }, ports);

    expect(result).toBe('application-sid');
    expect(internal.applicationSid).toBe('application-sid');
    expect(internal.cliSessionId).toBe('application-sid');
    expect(ports.renameSdkSession).not.toHaveBeenCalled();
    expect(ports.updateCliSessionId).not.toHaveBeenCalled();
    expect(onFirstId).toHaveBeenCalledWith('application-sid');
    expect(ports.warn).toHaveBeenCalledWith(expect.stringContaining('runtime-only-sid'));
  });

  it('updates a reused application record for a fresh CLI fallback', () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'application-sid' });
    const ports = host();

    const result = adoptClaudeStreamFirstIdCore({
      sessions: new Map([['application-sid', internal]]),
      internal,
      tempKey: 'temp-sid',
      incomingId: 'fresh-cli-sid',
      applicationResumeId: 'application-sid',
      resumeMode: 'fresh-cli-reuse-app',
      onFirstId: vi.fn(),
    }, ports);

    expect(result).toBe('fresh-cli-sid');
    expect(internal.applicationSid).toBe('application-sid');
    expect(internal.cliSessionId).toBe('fresh-cli-sid');
    expect(ports.renameSdkSession).not.toHaveBeenCalled();
    expect(ports.updateCliSessionId).toHaveBeenCalledOnce();
    expect(ports.updateCliSessionId).toHaveBeenCalledWith(
      'application-sid',
      'fresh-cli-sid',
    );
  });

  it('ignores closed spawns and first ids arriving after timeout fallback', () => {
    const closed = makeInternalSession({ cwd: '/workspace', applicationSid: 'temp-sid' });
    closed.expectedClose = true;
    const closedHost = host();
    const closedCallback = vi.fn();

    expect(adoptClaudeStreamFirstIdCore({
      sessions: new Map([['temp-sid', closed]]),
      internal: closed,
      tempKey: 'temp-sid',
      incomingId: 'late-sid',
      onFirstId: closedCallback,
    }, closedHost)).toBeNull();
    expect(closedCallback).not.toHaveBeenCalled();

    const fallback = makeInternalSession({ cwd: '/workspace', applicationSid: 'application-sid' });
    fallback.cliSessionId = 'fallback-sid';
    const fallbackHost = host();
    const fallbackCallback = vi.fn();
    expect(adoptClaudeStreamFirstIdCore({
      sessions: new Map([['application-sid', fallback]]),
      internal: fallback,
      tempKey: 'temp-sid',
      incomingId: 'late-sid',
      applicationResumeId: 'application-sid',
      onFirstId: fallbackCallback,
    }, fallbackHost)).toBeNull();
    expect(fallback.cliSessionId).toBe('fallback-sid');
    expect(fallbackCallback).not.toHaveBeenCalled();
    expect(fallbackHost.updateCliSessionId).not.toHaveBeenCalled();
  });
});
