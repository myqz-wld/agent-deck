/**
 * 测试用 sessionRepo mock factory（R37 P2-F Step 3.1）。
 *
 * 抽自 `src/main/session/__tests__/manager-test-setup.ts` 的 `makeSessionRepoMock`，
 * 加 `setSpawnLink / setTitle / getSpawnDepth / listAncestors / listChildren`
 * 等 spawn-chain 扩展 method 的 stateful default，让 mcp-tools / spawn-guards
 * 等 test 也能复用同一份 factory（之前各文件 inline 写自己的 mock，13 个 test 散落）。
 *
 * **vi.mock factory hoisting 约束**：
 * 每个 test 文件顶部仍要写 `vi.mock('@main/store/session-repo', () => ({ sessionRepo: makeSessionRepoMock(...) }))`
 * 这一句（vitest hoist 约束跨文件 import factory 函数 OK，但 vi.mock 调用本身必须在调用方文件内）。
 * factory 内部 `vi.fn()` / 闭包引用 caller 传入的 `sessions` Map 都安全（vi.mock factory 是 lazy
 * execution，实际只在 mocked 模块第一次被加载时被调用，那时所有 import 已解析）。
 *
 * **stateful 容器**：
 * 默认 factory 内部建 `Map<string, SessionRecord>`，caller 通过返回值的 `__sessions` 字段拿引用
 * 直接读 / 改。caller 也可显式传 `sessions` 让两个 mock object 共享同一 Map（如 manager-test-setup.ts
 * 的 mockSessions 模式）。
 *
 * **overrides**：
 * 任何 method 都可被 caller 覆盖（用 vi.fn() 包装 spy / 改 stateful 行为）。Factory 默认实现
 * 已写够大部分 test 直接用，只在 spy call args 或自定 stateful 行为时才需要 override。
 */

import { vi } from 'vitest';
import type { SessionRecord } from '@shared/types';

/** Factory 选项 */
export interface SessionRepoMockOptions {
  /** 外部 state 容器；不传则 factory 内部建一个新 Map */
  sessions?: Map<string, SessionRecord>;
  /** 部分覆盖 default method 实现（spy / 自定 stateful 行为） */
  overrides?: Record<string, unknown>;
}

/** Mock factory 返回值类型（保留 overrides 字段灵活性，stateful Map 通过 `__sessions` 暴露） */
export type SessionRepoMock = Record<string, unknown> & {
  /** factory 内部 / caller 共享的 sessions Map（caller 直接 set/get/clear） */
  __sessions: Map<string, SessionRecord>;
};

export function makeSessionRepoMock(opts: SessionRepoMockOptions = {}): SessionRepoMock {
  const sessions = opts.sessions ?? new Map<string, SessionRecord>();

  const base = {
    // ─── core CRUD ───
    get: (id: string) => sessions.get(id) ?? null,
    upsert: (rec: SessionRecord) => {
      sessions.set(rec.id, rec);
    },
    delete: (id: string) => {
      sessions.delete(id);
    },
    listActiveAndDormant: (limit?: number) =>
      [...sessions.values()]
        .filter((s) => s.lifecycle !== 'closed' && s.archivedAt === null)
        .slice(0, limit ?? 100),
    listHistory: () => [] as SessionRecord[],

    // ─── per-session setter ───
    setActivity: (id: string, activity: SessionRecord['activity'], ts: number) => {
      const r = sessions.get(id);
      if (r) sessions.set(id, { ...r, activity, lastEventAt: ts });
    },
    setLifecycle: (id: string, lifecycle: SessionRecord['lifecycle'], ts: number) => {
      const r = sessions.get(id);
      if (r) {
        sessions.set(id, {
          ...r,
          lifecycle,
          endedAt: lifecycle === 'closed' ? ts : null,
        });
      }
    },
    setArchived: (id: string, ts: number | null) => {
      // archive-toctou-fix-20260515 plan (R2 reviewer-codex LOW-2): 与生产 setArchived 行为对齐
      // 应当 throw SessionRowMissingError 当 id 不在,但 vi.mock 把 '@main/store/session-repo' 整个
      // module 替换 → mock factory 内 import SessionRowMissingError 撞 TDZ (循环陷阱)。修法需在
      // 12 个使用 makeSessionRepoMock 的测试文件 vi.mock factory 里 importActual + spread
      // SessionRowMissingError,工作量大且属测试基建升级。本 plan 标 LOW acceptable 留 P2 plan,
      // 与 codex LOW-2 originaml 评估「scope 评估值不值,如有现成 pattern 建议补」一致。
      const r = sessions.get(id);
      if (r) sessions.set(id, { ...r, archivedAt: ts });
    },
    // R2 reviewer-codex MED 修法: archive() 新增 clearCwdReleaseMarker(sessionId) 调用,
    // mock 必须补该 method 否则 manager-public-api.test.ts 撞 TypeError。
    // 与生产 sessionRepo.clearCwdReleaseMarker 语义一致(置 cwdReleaseMarker = null)。
    clearCwdReleaseMarker: (id: string) => {
      const r = sessions.get(id);
      if (r) sessions.set(id, { ...r, cwdReleaseMarker: null });
    },
    setPermissionMode: vi.fn(),
    setTitle: (id: string, title: string) => {
      const r = sessions.get(id);
      if (r) sessions.set(id, { ...r, title });
    },
    setCodexSandbox: vi.fn(),
    setClaudeCodeSandbox: vi.fn(),
    setModel: vi.fn(),
    // R3 reviewer-claude LOW 修法:与 setClaudeCodeSandbox / setModel 同款 vi.fn 桩
    // (大部分测试不消费返回值,显式调用走 mockClear / toHaveBeenCalledWith 即可)。
    setExtraAllowWrite: vi.fn(),

    // ─── rename ───
    rename: vi.fn(),

    // ─── plan reverse-rename-sid-stability-20260520 §A.4-pre cli_session_id 列 ───
    findByCliSessionId: (cliSid: string) => {
      for (const r of sessions.values()) {
        if ((r.cliSessionId ?? null) === cliSid) return r;
      }
      return null;
    },
    updateCliSessionId: (id: string, newCliSid: string | null) => {
      const r = sessions.get(id);
      if (r) sessions.set(id, { ...r, cliSessionId: newCliSid });
    },

    // ─── spawn-chain（mcp tools / spawn-guards 用） ───
    getSpawnDepth: (id: string) => sessions.get(id)?.spawnDepth ?? 0,
    setSpawnLink: (id: string, parentId: string | null, depth: number) => {
      const r = sessions.get(id);
      if (r) sessions.set(id, { ...r, spawnedBy: parentId, spawnDepth: depth });
    },
    listAncestors: (id: string) => {
      const out: SessionRecord[] = [];
      let cursor = sessions.get(id);
      const visited = new Set<string>([id]);
      while (cursor && cursor.spawnedBy && !visited.has(cursor.spawnedBy)) {
        visited.add(cursor.spawnedBy);
        const parent = sessions.get(cursor.spawnedBy);
        if (!parent) break;
        out.push(parent);
        cursor = parent;
      }
      return out;
    },
    listChildren: (parentId: string) =>
      [...sessions.values()].filter(
        (s) => s.spawnedBy === parentId && s.lifecycle === 'active',
      ),
  };

  return Object.assign(base, opts.overrides ?? {}, { __sessions: sessions });
}
