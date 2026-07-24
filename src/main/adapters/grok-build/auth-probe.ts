import type { AuthMethod } from '@agentclientprotocol/sdk';
import type { GrokAuthProbeResult } from '@shared/types';
import { GrokAcpProcess } from './acp-process';

function authType(method: AuthMethod): string {
  return 'type' in method ? method.type : 'agent';
}

/** Initialize and authenticate only. No Grok session or paid model prompt is created. */
export async function probeGrokAuthentication(options: {
  binary: string;
  cwd: string;
}): Promise<GrokAuthProbeResult> {
  let process: GrokAcpProcess | null = null;
  try {
    process = await GrokAcpProcess.start({
      ...options,
      onSessionUpdate: () => undefined,
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    return {
      ok: true,
      methodId: process.authenticatedMethodId,
      methods: (process.initializeResponse.authMethods ?? []).map((method) => ({
        id: method.id,
        name: method.name,
        type: authType(method),
      })),
      usedLoginShell: process.usedLoginShell,
    };
  } catch (error) {
    return {
      ok: false,
      methodId: null,
      methods: [],
      usedLoginShell: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await process?.stop();
  }
}
