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
 * SessionDetail TasksPanel 订阅 onTaskChanged 同款 component 自订阅模式;`use-event-bridge.ts`
 * 不动）。
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
  /**
   * list fetch resolve 专用：把 list snapshot merge 进 store（逐 id 保留 updatedAt 更大的版本），
   * **保留** store 内 list snapshot 未含的 id（deep-review H1 R2 MED：慢 list fetch 在途期间
   * onIssueChanged 新建 / 移入当前 filter 的 issue 不在旧 snapshot 内，旧实现整表替换会把它从 store
   * 剔除导致列表瞬时丢行）。
   *
   * 为何 keep-all 安全：① 可见列表由 `selectFilteredIssues` 渲染时按 filters 重新过滤（store Map 是
   * 超集 cache 非 filter 镜像），out-of-scope 的滞留行不会显示；② hardDelete 走 removeIssue 显式删，
   * 不依赖 list membership；③ eventBus 进程内不丢事件 + store 重启清空，滞留 stale 行近乎不可达，
   * 且下次 filter 变 / refetch 自愈。逐 id 仍保 updatedAt 更大版本防慢 fetch 退回 event 已 sync 的最新。
   */
  mergeIssuesFromList: (records: IssueRecord[]) => void;
  upsertIssue: (record: IssueRecord) => void;
  /** hardDelete 路径：从 Map 删 + 若 selected 跟着 deselect */
  removeIssue: (id: string) => void;
  selectIssue: (id: string | null) => void;
  /**
   * 支持 functional updater（与 React setState 同款）：debounce / 异步 callback 必须用
   * `setFilters(prev => ...)` 读最新 filters，否则闭包捕获的旧 filters 会覆盖期间用户的
   * tab / kind / showDeleted 切换（reviewer-codex MED：搜索 debounce 旧闭包覆盖刚切的 tab）。
   */
  setFilters: (filters: IssueFilters | ((prev: IssueFilters) => IssueFilters)) => void;
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

  // list resolve merge：从当前 store 副本出发（keep-all 保留 snapshot 未含的 id，防瞬时丢行），
  // 逐 id 用 list 版本覆盖但保留 updatedAt 更大的本地版本。appendices 同 upsert 语义：list 行不带
  // appendices（避免 N+1），故 list 版本胜出时若旧版本已有 appendices 子列表则保住（避免详情已拉到
  // 的补充记录被裸 list 记录抹掉）。
  mergeIssuesFromList: (records) => {
    set((s) => {
      const next = new Map(s.issues);
      for (const r of records) {
        const existing = s.issues.get(r.id);
        if (existing && existing.updatedAt > r.updatedAt) continue; // 本地更新 → 保留，不退回
        next.set(
          r.id,
          r.appendices === undefined && existing?.appendices !== undefined
            ? { ...r, appendices: existing.appendices }
            : r,
        );
      }
      return { issues: next };
    });
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

  // functional updater 支持：传 fn 时基于最新 filters 计算（debounce callback 防旧闭包覆盖）。
  setFilters: (filters) =>
    set((s) => ({ filters: typeof filters === 'function' ? filters(s.filters) : filters })),
}));

/**
 * Selector: list 视图按 createdAt DESC 排序的 issues 数组（filter 应用在此）。
 *
 * 注：filter 在 IPC 层已应用一次（issueRepo.list 已按 statuses / kinds / titleKeyword /
 * includeDeleted 过滤），但实时事件流（issue-changed kind=created/updated 等）会让 store
 * 含跨 filter scope 的 issue（如 filter showDeleted=false 但收到 kind=softDeleted event 后
 * issue 仍在 store 里），所以渲染前再过滤一次。
 */
export function selectFilteredIssues(
  state: Pick<IssuesState, 'issues' | 'filters'>,
): IssueRecord[] {
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
