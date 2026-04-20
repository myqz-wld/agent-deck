import { fileChangeRepo } from '@main/store/file-change-repo';
import type { FileChangeRecord } from '@shared/types';

/**
 * DiffCollector 暴露了 file_changes 的查询接口。事件入库由 SessionManager
 * 在收到 file-changed 时直接完成，这里只负责读取。
 */
export const diffCollector = {
  listForSession(sessionId: string): FileChangeRecord[] {
    return fileChangeRepo.listForSession(sessionId);
  },
  countForSession(sessionId: string): number {
    return fileChangeRepo.countForSession(sessionId);
  },
};
