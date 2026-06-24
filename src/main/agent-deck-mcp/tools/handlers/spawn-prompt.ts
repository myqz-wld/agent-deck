import type { SessionRecord } from '@shared/types';
import type { CallerContext } from '../../types';
import type { SpawnSessionArgs } from '../schemas';
import { buildLeadContextBlock } from './lead-context-block';
import { shouldWriteSpawnLink } from './spawn-link-guard';

export interface BuildSpawnPromptContextInput {
  args: SpawnSessionArgs;
  caller: CallerContext;
  callerExists: boolean;
  leadRecord: Pick<SessionRecord, 'agentId' | 'title'> | null;
  leadDisplayName: string | null;
  promptToUse: string;
  teamIdEarly: string | null;
  handOffMode?: boolean;
}

export interface BuildSpawnPromptContextResult {
  shouldWriteNormalSpawnLink: boolean;
  willInjectWirePrefix: boolean;
  placeholderId: string | null;
  promptForSpawn: string;
}

export function buildSpawnPromptContext(
  input: BuildSpawnPromptContextInput,
): BuildSpawnPromptContextResult {
  const shouldWriteNormalSpawnLink =
    input.callerExists && shouldWriteSpawnLink({ handOffMode: input.handOffMode });
  const willInjectWirePrefix = shouldWriteNormalSpawnLink;
  let placeholderId: string | null = null;
  let promptForSpawn = input.promptToUse;

  if (willInjectWirePrefix) {
    const newPlaceholderId = crypto.randomUUID();
    placeholderId = newPlaceholderId;
    const leadAdapter = input.leadRecord?.agentId ?? 'unknown-adapter';
    const { wirePrefix, contextBlock } = buildLeadContextBlock({
      leadSessionId: input.caller.callerSessionId,
      teamId: input.teamIdEarly,
      leadDisplayName: input.leadDisplayName,
      leadAdapter,
      placeholderId: newPlaceholderId,
    });
    promptForSpawn = `${wirePrefix}${contextBlock}\n---\n\n${input.promptToUse}`;
  }

  return {
    shouldWriteNormalSpawnLink,
    willInjectWirePrefix,
    placeholderId,
    promptForSpawn,
  };
}
