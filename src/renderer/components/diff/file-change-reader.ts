import type { FileChangePayload } from '@shared/types';

export interface FileChangeReader {
  identity: string;
  read(sessionId: string, changeId: number): Promise<FileChangePayload | null>;
}

export const LOCAL_FILE_CHANGES: FileChangeReader = {
  identity: 'local',
  read: (sessionId, changeId) => window.api.getFileChange(sessionId, changeId),
};
