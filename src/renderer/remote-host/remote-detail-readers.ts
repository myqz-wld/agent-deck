import { REMOTE_HOST_PAGE_LIMIT } from '@shared/remote-host';
import type {
  RemoteHostFileChangeGetDto,
  RemoteHostFileChangePageDto,
  RemoteHostFileFinalDiffDto,
} from '@shared/remote-host';
import type { ImageSource, LoadImageBlobResult } from '@shared/types';

interface RemoteTarget {
  profileId: string;
  sessionId: string;
}

export interface RemoteDetailReaders {
  listFileChanges(cursor?: string): Promise<RemoteHostFileChangePageDto>;
  getFileChange(changeId: number): Promise<RemoteHostFileChangeGetDto>;
  getFileFinalDiff(filePath: string): Promise<RemoteHostFileFinalDiffDto>;
  loadImageBlob(sessionId: string, source: ImageSource): Promise<LoadImageBlobResult>;
}

export function createRemoteDetailReaders(options: {
  currentIdentity(): string;
  requireCapability(capability: string): void;
  target(): RemoteTarget;
}): RemoteDetailReaders {
  const read = async <T>(
    capability: string,
    consume: (target: RemoteTarget) => Promise<T>,
  ): Promise<T> => {
    options.requireCapability(capability);
    const identity = options.currentIdentity();
    const result = await consume(options.target());
    if (options.currentIdentity() !== identity) throw new Error('数据源已切换，请重试。');
    return result;
  };
  return {
    listFileChanges: (cursor) => read('sessions.file-changes.read', (target) =>
      window.api.listRemoteHostFileChanges({
      ...target,
      ...(cursor ? { cursor } : {}),
      limit: REMOTE_HOST_PAGE_LIMIT,
    })),
    getFileChange: (changeId) => read('sessions.file-changes.read', (target) =>
      window.api.getRemoteHostFileChange({ ...target, changeId })),
    getFileFinalDiff: (filePath) => read('sessions.file-changes.read', (target) =>
      window.api.getRemoteHostFileFinalDiff({ ...target, filePath })),
    loadImageBlob: (sessionId, source) => {
      if (source.kind !== 'remote-file-change') {
        return Promise.resolve({ ok: false, reason: 'unsupported_source' });
      }
      return read('assets', async (target) => {
        if (target.sessionId !== sessionId) return { ok: false, reason: 'denied' };
        return window.api.loadRemoteHostImageAsset({ ...target, source });
      });
    },
  };
}
