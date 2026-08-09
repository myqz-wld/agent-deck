import { describe, expect, it } from 'vitest';

import { desktopClaudeSdkRuntimeHost } from './sdk-runtime-host';

describe('desktopClaudeSdkRuntimeHost', () => {
  it('exposes the current process and resolves from the adapter module location', () => {
    expect(desktopClaudeSdkRuntimeHost.environment()).toBe(process.env);
    expect(desktopClaudeSdkRuntimeHost.executablePath()).toBe(process.execPath);
    expect(desktopClaudeSdkRuntimeHost.platform()).toBe(process.platform);
    expect(desktopClaudeSdkRuntimeHost.architecture()).toBe(process.arch);
    expect(
      desktopClaudeSdkRuntimeHost.resolveModule('@anthropic-ai/claude-agent-sdk'),
    ).toContain('@anthropic-ai/claude-agent-sdk');
  });
});
