import { describe, expect, it } from 'vitest';

import { publicConnectionError, publicRemoteHostError } from './errors';

describe('remote host public errors', () => {
  it('maps unknown attacker-controlled codes and messages to a fixed public error', () => {
    const publicError = publicRemoteHostError({
      code: '/private/keys/desktop-key',
      message: 'Offending key in /private/trust/known_hosts',
    });
    const connectionError = publicConnectionError({
      code: '../known_hosts',
      message: 'Offending key in /private/trust/known_hosts',
    });

    expect(publicError).toMatchObject({
      code: 'internal_error',
      message: '远程主机操作失败，请重试。',
    });
    expect(connectionError).toEqual({
      code: 'internal_error',
      message: '远程连接不可用，请检查配置后重试。',
    });
    expect(JSON.stringify({ publicError, connectionError })).not.toContain('/private/');
  });
});
