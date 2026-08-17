import { describe, expect, it } from 'vitest';

import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it('removes Electron IPC implementation details from user-facing errors', () => {
    expect(errorMessage(new Error(
      "Error invoking remote method 'adapter:set-session-model-options': " +
        'Error: 当前回复进行中，暂时不能切换模型网关。',
    ))).toBe('当前回复进行中，暂时不能切换模型网关。');
  });

  it('removes the Remote public-error wrapper', () => {
    expect(errorMessage(
      'Error invoking remote method: RemoteHostPublicError: 模型网关不可用。',
    )).toBe('模型网关不可用。');
  });
});
