import {
  assertRelayRouteFrame,
  RelayRouteFrameError,
  type RelayRouteFrame,
} from '@protocol/relay';

const MAX_OUTPUT_DATA_CHUNK_BYTES = 64 * 1024;
const OUTPUT_CHUNK_PROBE = new Uint8Array(MAX_OUTPUT_DATA_CHUNK_BYTES);

interface RelayOutputChunkOptions {
  instanceId: string;
  generation: number;
  streamId: string;
  initialCreditBytes: number;
  maxCreditBytes: number;
  maxFrameBytes: number;
}

/**
 * Keep every Worker-to-client data frame small enough to make progress from the initial credit.
 * Probe the encoded body limit as well because route metadata consumes part of maxFrameBytes.
 */
export function resolveRelayOutputChunkBytes(options: RelayOutputChunkOptions): number {
  let lower = 1;
  let upper = Math.min(
    MAX_OUTPUT_DATA_CHUNK_BYTES,
    options.initialCreditBytes,
    options.maxFrameBytes,
  );
  let resolved = 0;

  const fits = (candidate: number): boolean => {
    const frame: RelayRouteFrame = {
      instanceId: options.instanceId,
      generation: options.generation,
      streamId: options.streamId,
      direction: 'worker-to-client',
      sequence: Number.MAX_SAFE_INTEGER,
      kind: 'data',
      payload: OUTPUT_CHUNK_PROBE.subarray(0, candidate),
      creditBytes: null,
      resetCode: null,
      connectionScope: null,
      accessSurface: null,
      accessGrant: null,
    };
    try {
      assertRelayRouteFrame(frame, {
        maxFrameBytes: options.maxFrameBytes,
        maxCreditBytes: options.maxCreditBytes,
      });
      return true;
    } catch (error) {
      if (!(error instanceof RelayRouteFrameError) || error.code !== 'frame_oversized') {
        throw error;
      }
      return false;
    }
  };

  if (fits(upper)) return upper;

  while (lower <= upper) {
    const candidate = lower + Math.floor((upper - lower) / 2);
    if (fits(candidate)) {
      resolved = candidate;
      lower = candidate + 1;
    } else {
      upper = candidate - 1;
    }
  }

  if (resolved === 0) {
    throw new RangeError('Relay frame limits leave no room for Worker output data');
  }
  return resolved;
}
