import { IpcInvoke } from '@shared/ipc-channels';
import { adapterRegistry } from '@main/adapters/registry';
import { isAgentId } from '@main/adapters/options-builder';
import {
  normalizeSessionModelOptions,
  SessionModelOptionsError,
} from '@main/adapters/session-model-options';
import { sessionRepo } from '@main/store/session-repo';
import { IpcInputError, on, parseStringId } from './_helpers';

/** Register the isolated next-turn model / thinking mutation endpoint. */
export function registerSessionModelOptionsIpc(): void {
  on(IpcInvoke.AdapterSetSessionModelOptions, async (_e, agentId, sessionId, rawOptions) => {
    const validAgentId = parseStringId('agentId', agentId, 64);
    if (!isAgentId(validAgentId)) {
      throw new IpcInputError('agentId', 'unknown adapter');
    }
    const adapter = adapterRegistry.get(validAgentId);
    if (!adapter?.capabilities.canSetSessionModelOptions || !adapter.setSessionModelOptions) {
      throw new Error('adapter cannot set session model options');
    }

    const sid = parseStringId('sessionId', sessionId);
    const record = sessionRepo.get(sid);
    if (!record) throw new Error(`session ${sid} not found`);
    if (record.agentId !== validAgentId) {
      throw new IpcInputError('agentId', `does not own session ${sid}`);
    }
    if (record.source !== 'sdk') {
      throw new Error('external CLI sessions cannot be reconfigured by Agent Deck');
    }
    if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
      throw new IpcInputError('options', 'must be object');
    }

    try {
      const raw = rawOptions as Record<string, unknown>;
      await adapter.setSessionModelOptions(
        sid,
        normalizeSessionModelOptions(validAgentId, {
          model: raw.model,
          thinking: raw.thinking,
        }),
      );
    } catch (error) {
      if (error instanceof SessionModelOptionsError) {
        throw new IpcInputError(`options.${error.field}`, error.message);
      }
      throw error;
    }
    return true;
  });
}
