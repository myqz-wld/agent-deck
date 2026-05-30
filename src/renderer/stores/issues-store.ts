/**
 * Issue Tracker renderer store（plan issue-tracker-mcp-20260529 §Step 3.8.5）。
 *
 * MVP 单 zustand store 含：
 * - issues: Map<string, IssueRecord>（list + detail 同源，支持快速 lookup）
 * - 当前 filter state（statuses 多选 / kinds 多选 / titleKeyword / showDeleted toggle）
 * - selectedIssueId（detail 视图驱动）
 * - reducer: setIssues / upsertIssue / removeIssue（hardDeleted）
 *
 * **订阅模式**: IssuesPanel useEffect 启动时 `window.api.onIssueChanged` 推 reducer（与
 * onTaskChanged "renderer 没消费此事件 — 加 Tasks tab 直接 onTaskChanged 订阅" 同款 component
 * 自订阅模式;`use-event-bridge.ts` 不动）。
 *
 * **list 排序**: createdAt DESC（与 IPC handler issueRepo.list 默认排序对齐）— 渲染时把
 * Map.values() 按 createdAt desc sort。
 */

import { create } from 'zustand';
import type { IssueRecord, IssueStatus } from '@shared/types';

export interface IssueFilters {
  /** 多选 status，[] 或 undefined = 不过滤 */
  statuses?: IssueStatus[];
  /** 多选 kind，[] 或 undefined = 不过滤 */
  kinds?: string[];
  /** 大小写不敏感 substring 匹配 */
  titleKeyword?: string;
  /** 是否显示软删（默认 false 隐藏） */
  showDeleted?: boolean;
}

interface IssuesState {
  /** 当前已加载 issues 集合（list + detail 同源 by id） */
  issues: Map<string, IssueRecord>;
  /** detail 视图驱动 — null = list 模式 */
  selectedIssueId: string | null;
  /** 当前 filter state；filter 变了重新触发 fetch list */
  filters: IssueFilters;

  setIssues: (records: IssueRecord[]) => void;
  upsertIssue: (record: IssueRecord) => void;
  /** hardDelete 路径：从 Map 删 + 若 selected 跟着 deselect */
  removeIssue: (id: string) => void;
  selectIssue: (id: string | null) => void;
  setFilters: (filters: IssueFilters) => void;
}

export const useIssuesStore = create<IssuesState>((set) => ({
  issues: new Map(),
  selectedIssueId: null,
  // 默认「活跃」视图：只显示 open + in-progress，隐藏 resolved（resolved 走「已解决」tab）+ 隐藏软删
  filters: { statuses: ['open', 'in-progress'], showDeleted: false },

  setIssues: (records) => {
    const next = new Map<string, IssueRecord>();
    for (const r of records) next.set(r.id, r);
    set({ issues: next });
  },

  upsertIssue: (record) => {
    set((s) => {
      const next = new Map(s.issues);
      next.set(record.id, record);
      return { issues: next };
    });
  },

  removeIssue: (id) => {
    set((s) => {
      const next = new Map(s.issues);
      next.delete(id);
      return {
        issues: next,
        selectedIssueId: s.selectedIssueId === id ? null : s.selectedIssueId,
      };
    });
  },

  selectIssue: (id) => set({ selectedIssueId: id }),

  setFilters: (filters) => set({ filters }),
}));

/**
 * Selector: list 视图按 createdAt DESC 排序的 issues 数组（filter 应用在此）。
 *
 * 注：filter 在 IPC 层已应用一次（issueRepo.list 已按 statuses / kinds / titleKeyword /
 * includeDeleted 过滤），但实时事件流（issue-changed kind=created/updated 等）会让 store
 * 含跨 filter scope 的 issue（如 filter showDeleted=false 但收到 kind=softDeleted event 后
 * issue 仍在 store 里），所以渲染前再过滤一次。
 */
export function selectFilteredIssues(state: IssuesState): IssueRecord[] {
  const { issues, filters } = state;
  const arr = Array.from(issues.values());
  return arr
    .filter((i) => {
      // showDeleted=false → 隐藏 deletedAt 非 null
      if (!filters.showDeleted && i.deletedAt !== null) return false;
      // statuses 多选
      if (filters.statuses && filters.statuses.length > 0) {
        if (!filters.statuses.includes(i.status)) return false;
      }
      // kinds 多选
      if (filters.kinds && filters.kinds.length > 0) {
        if (!filters.kinds.includes(i.kind)) return false;
      }
      // titleKeyword 大小写不敏感
      if (filters.titleKeyword && filters.titleKeyword.trim()) {
        const kw = filters.titleKeyword.trim().toLowerCase();
        if (!i.title.toLowerCase().includes(kw)) return false;
      }
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
