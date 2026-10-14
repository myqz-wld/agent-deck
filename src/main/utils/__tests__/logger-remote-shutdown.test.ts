import { afterEach, describe, expect, it } from 'vitest';
import { shouldDropExpectedRemoteHostStaleScopeNoise } from '../logger';
import { setRemoteShutdownLogState } from '../remote-shutdown-log-state';

afterEach(() => setRemoteShutdownLogState(false));

describe('shutdown-only Remote IPC log suppression', () => {
  const message = (code: string, channel = 'remote-host:snapshot') => ({ data: [
    `Error occurred in handler for '${channel}':`,
    { name: 'RemoteHostPublicError', code },
  ] });

  it('keeps unexpected service loss visible while running and after a reset', () => {
    expect(shouldDropExpectedRemoteHostStaleScopeNoise(message('service_stopped'))).toBe(false);
    setRemoteShutdownLogState(true);
    expect(shouldDropExpectedRemoteHostStaleScopeNoise(message('service_stopped'))).toBe(true);
    setRemoteShutdownLogState(false);
    expect(shouldDropExpectedRemoteHostStaleScopeNoise(message('service_stopped'))).toBe(false);
  });

  it('does not suppress unrelated errors or other IPC namespaces during shutdown', () => {
    setRemoteShutdownLogState(true);
    expect(shouldDropExpectedRemoteHostStaleScopeNoise(message('internal_error'))).toBe(false);
    expect(shouldDropExpectedRemoteHostStaleScopeNoise(message('service_stopped', 'session:get'))).toBe(false);
  });
});
