import { publishAssetSnapshot } from '@main/runtime-assets/snapshot-store';
import { sessionAssetSelections } from '@main/runtime-assets/session-selection';

export interface SkillsMirrorFilesystem {
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

export interface SkillsMirrorSyncRequest {
  source: string;
  destination: string;
}

export type SkillsMirrorDiagnostic =
  | { kind: 'source-missing'; source: string }
  | { kind: 'source-inspection-failed'; source: string; error: unknown }
  | { kind: 'prepare-failed'; destination: string; error: unknown }
  | { kind: 'rollback-failed'; destination: string; error: unknown }
  | { kind: 'cleanup-failed'; operation: 'staging' | 'backup'; path: string; error: unknown };

export interface SkillsMirrorStore {
  snapshotPath(destination: string): string | null;
  sync(request: SkillsMirrorSyncRequest): string[] | null;
}

export function createSkillsMirrorStore(options: {
  filesystem: SkillsMirrorFilesystem;
  transformMarkdown: (content: string) => string;
  diagnostic?: (event: SkillsMirrorDiagnostic) => void;
  operationTag?: string;
}): SkillsMirrorStore {
  const { filesystem, transformMarkdown, diagnostic } = options;
  const prepared = new Map<string, string>();
  return {
    snapshotPath: destination => prepared.get(destination) ?? null,
    sync(request) {
      sessionAssetSelections(request.destination);
      prepared.delete(request.destination);
      if (!filesystem.existsSync(request.source)) {
        diagnostic?.({ kind: 'source-missing', source: request.source });
        return null;
      }
      try {
        const snapshot = publishAssetSnapshot({
          ...request, identity: { provider: 'codex', skills: true }, transformMarkdown,
        }, filesystem);
        sessionAssetSelections(request.destination).retire([snapshot.path]);
        prepared.set(request.destination, snapshot.path);
        return snapshot.entries.filter(entry => entry.kind === 'file'
          && /^[^/]+\/SKILL\.md$/.test(entry.path)).map(entry => entry.path.split('/')[0]!);
      } catch (error) {
        diagnostic?.({ kind: 'prepare-failed', destination: request.destination, error });
        return null;
      }
    },
  };
}
