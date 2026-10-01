import type { SessionRecord } from '@shared/types';
import type { ServerCoreSpawnGuardSessions } from './mcp-spawn-guard';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';

/** Independent work retains creation accounting without masquerading as a delegated child. */
export function creationGuardSessions(
  sessions: ServerCoreSpawnGuardSessions & { get(id: string): SessionRecord | null },
  metadata: Pick<ServerCoreRuntimeMetadataStore, 'feishuWorkOrigins'>,
): ServerCoreSpawnGuardSessions {
  return { listChildren: (parentId, lifecycle) => {
    const related = new Map(sessions.listChildren(parentId, lifecycle).map(row => [row.id, row]));
    for (const origin of metadata.feishuWorkOrigins(parentId)) {
      const row = sessions.get(origin.sessionId);
      if (row?.lifecycle === lifecycle && row.archivedAt === null) related.set(row.id, row);
    }
    return [...related.values()];
  } };
}
