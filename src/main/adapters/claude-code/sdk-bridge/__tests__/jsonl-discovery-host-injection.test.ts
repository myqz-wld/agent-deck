import { describe, expect, it, vi } from 'vitest';

import { ClaudeSdkBridge } from '../index';
import type { SdkBridgeOptions } from '../types';

class ProbeBridge extends ClaudeSdkBridge {
  probe(cwd: string, sessionId: string): {
    exists: boolean;
    mtimeMs: number | null;
    cwdExists: boolean;
  } {
    return {
      exists: this.resumeJsonlExists(cwd, sessionId),
      mtimeMs: this.resumeJsonlMtimeMs(cwd, sessionId),
      cwdExists: this.cwdExists(cwd),
    };
  }
}

describe('Claude bridge jsonl discovery host', () => {
  it('routes transcript and cwd probes through the injected filesystem host', () => {
    const transcriptPath = vi.fn(() => '/transcripts/session-a.jsonl');
    const pathExists = vi.fn((path: string) => path !== '/repo');
    const pathMtimeMs = vi.fn(() => 456);
    const bridge = new ProbeBridge({
      createSessionHost: {},
      jsonlDiscoveryHost: { transcriptPath, pathExists, pathMtimeMs },
      recoveryFreshnessHost: {},
      restartSessionHost: { subscribeRenames: () => vi.fn(), warn: vi.fn() },
      sessionModelHost: {},
      permissionResponderHost: {},
      cwdTransitionHost: {},
      messageControllerHost: {},
      sessionLifecycleHost: {},
      pendingOutgoingHost: {},
      streamProcessorHost: {},
      sessionFinalizeHost: {},
      canUseToolHost: {},
      createSessionSdkQueryHost: {},
      sessionManager: {},
      emit: vi.fn(),
    } as unknown as SdkBridgeOptions);

    expect(bridge.probe('/repo', 'session-a')).toEqual({
      exists: true,
      mtimeMs: 456,
      cwdExists: false,
    });
    expect(transcriptPath).toHaveBeenCalledTimes(2);
    expect(transcriptPath).toHaveBeenNthCalledWith(1, '/repo', 'session-a');
    expect(pathExists).toHaveBeenNthCalledWith(1, '/transcripts/session-a.jsonl');
    expect(pathExists).toHaveBeenNthCalledWith(2, '/repo');
    expect(pathMtimeMs).toHaveBeenCalledWith('/transcripts/session-a.jsonl');
  });
});
