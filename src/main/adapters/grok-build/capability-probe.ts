import { GrokAcpProcess } from './acp-process';
import { resolveGrokBinary } from './resolve-grok-binary';

export async function probeGrokImageCapability(
  cwd: string,
  binaryPath: string | null,
  onNegotiated?: (supported: boolean) => void,
): Promise<boolean> {
  const binary = await resolveGrokBinary(binaryPath);
  const process = await GrokAcpProcess.start({
    binary,
    cwd,
    authenticate: false,
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
  });
  try {
    const supported =
      process.initializeResponse.agentCapabilities?.promptCapabilities?.image === true;
    onNegotiated?.(supported);
    return supported;
  } finally {
    await process.stop();
  }
}
