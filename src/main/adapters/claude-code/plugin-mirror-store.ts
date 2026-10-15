import { join } from 'node:path';
import { publishAssetSnapshot } from '@main/runtime-assets/snapshot-store';
import { sessionAssetSelections } from '@main/runtime-assets/session-selection';

export interface PluginMirrorFilesystem {
  cpSync: typeof import('node:fs').cpSync;
  existsSync: typeof import('node:fs').existsSync;
  mkdirSync: typeof import('node:fs').mkdirSync;
  mkdtempSync: typeof import('node:fs').mkdtempSync;
  readdirSync: typeof import('node:fs').readdirSync;
  readFileSync: typeof import('node:fs').readFileSync;
  renameSync: typeof import('node:fs').renameSync;
  rmSync: typeof import('node:fs').rmSync;
  writeFileSync: typeof import('node:fs').writeFileSync;
}

export interface PluginMirrorSyncRequest {
  source: string;
  destination: string;
  includeSkills: boolean;
  includeAgents: boolean;
}

export type PluginMirrorDiagnostic =
  | { kind: 'source-missing'; source: string }
  | { kind: 'install-failed'; destination: string; error: unknown }
  | { kind: 'rollback-failed'; destination: string; error: unknown }
  | { kind: 'cleanup-failed'; operation: 'staging' | 'backup'; path: string; error: unknown };

export interface PluginMirrorStore {
  sync(request: PluginMirrorSyncRequest): string | null;
}

export function createPluginMirrorStore(options: {
  filesystem: PluginMirrorFilesystem;
  transformMarkdown: (content: string) => string;
  diagnostic?: (event: PluginMirrorDiagnostic) => void;
  operationTag?: string;
}): PluginMirrorStore {
  const { filesystem, transformMarkdown, diagnostic } = options;
  return { sync(request) {
    sessionAssetSelections(request.destination);
    if (!filesystem.existsSync(request.source)) {
      diagnostic?.({ kind: 'source-missing', source: request.source });
      return null;
    }
    try {
      const snapshot = publishAssetSnapshot({
        ...request,
        identity: { provider: 'claude', skills: request.includeSkills, agents: request.includeAgents },
        omit: [ ...(!request.includeSkills ? ['skills'] : []), ...(!request.includeAgents ? ['agents'] : []) ],
        transformMarkdown,
        validate: path => { JSON.parse(filesystem.readFileSync(join(path, '.claude-plugin', 'plugin.json'), 'utf8')); },
      }, filesystem);
      sessionAssetSelections(request.destination).retire([snapshot.path]);
      return snapshot.path;
    } catch (error) {
      diagnostic?.({ kind: 'install-failed', destination: request.destination, error });
      return null;
    }
  } };
}
