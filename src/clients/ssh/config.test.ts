import { describe, expect, it } from 'vitest';

import { resolveSshTransportOptions } from './config';

describe('SSH transport control-frame capacity', () => {
  it('rejects profiles that cannot retain one normal and two control frames', () => {
    expect(() => resolveSshTransportOptions({
      bounds: { maxQueuedWriteFrames: 2 },
    })).toThrow(/reserve 2 control frames/u);
    expect(() => resolveSshTransportOptions({
      bounds: { maxQueuedWriteBytes: 1_024 },
    })).toThrow(/control-frame liveness/u);
    expect(() => resolveSshTransportOptions({
      bounds: { maxFrameBytes: 128 },
    })).toThrow(/maximum bounded control frame/u);
  });

  it('accepts the smallest frame-slot profile with a complete control reserve', () => {
    expect(resolveSshTransportOptions({
      bounds: { maxQueuedWriteFrames: 3 },
    }).bounds.maxQueuedWriteFrames).toBe(3);
  });
});
