// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.8 拆分共享层 (与 Step 4.7 window.ts / Step 4.5 task-repo
// _deps.ts 同款 pattern)。
//
// 收纳:
// - BootstrapState interface (module-level let 单例字段聚合)
// - createInitialBootstrapState() factory
// - makeDebouncedTeamSender<T> helper (R3.E9 IPC bridge 16ms debouncer)
// - CallerArchiveFailedToolName type narrowing + TOOL_DISPLAY_NAME 常量
// ────────────────────────────────────────────────────────────────────────────

import type { HookServer } from '../hook-server/server';
import type { RouteRegistry } from '../hook-server/route-registry';
import type { LifecycleScheduler } from '../session/lifecycle-scheduler';
import type { TeamLifecycleScheduler } from '../teams/team-lifecycle-scheduler';
import type { IssueLifecycleScheduler } from '../store/issue-lifecycle-scheduler';
import type { MessageLifecycleScheduler } from '../store/message-lifecycle-scheduler';
import type { TokenUsageLifecycleScheduler } from '../store/token-usage-lifecycle-scheduler';
import type { EventMap } from '../event-bus';

/**
 * Phase 4 Step 4.8 拆分:module-level let 单例聚合成单一 mutable state object。
 *
 * 用法:facade index.ts 持 `const state: BootstrapState = createInitialBootstrapState()`;
 * sub-module (bootstrap-infra / bootstrap-wiring / lifecycle-hooks) 接受 state 参数
 * 直接 read/write 同一引用,保 bootstrap god-function 拆分后 mutate 路径 byte-identical。
 *
 * 与 Step 4.7 window.ts FloatingWindowState 同款全字段 mutable interface pattern
 * (无真私有约束需求 — bootstrap 单例本身就是 module-level let,全字段 public 暴露)。
 */
export interface BootstrapState {
  hookServer: HookServer | null;
  routeRegistry: RouteRegistry | null;
  scheduler: LifecycleScheduler | null;
  teamScheduler: TeamLifecycleScheduler | null;
  /** plan issue-tracker-mcp-20260529 §Step 3.7.2 / §D13 / §D20: Issue Tracker GC scheduler */
  issueScheduler: IssueLifecycleScheduler | null;
  /** plan message-retention-and-index-20260602 §D8: agent_deck_messages retention GC scheduler */
  messageScheduler: MessageLifecycleScheduler | null;
  /** fixed 365d token_usage retention GC scheduler */
  tokenUsageScheduler: TokenUsageLifecycleScheduler | null;
  agentDeckMcpHttpShutdown: (() => Promise<void>) | null;
}

export function createInitialBootstrapState(): BootstrapState {
  return {
    hookServer: null,
    routeRegistry: null,
    scheduler: null,
    teamScheduler: null,
    issueScheduler: null,
    messageScheduler: null,
    tokenUsageScheduler: null,
    agentDeckMcpHttpShutdown: null,
  };
}

/**
 * plan log-noise-and-disposed-20260603 §D2 / §D3
 *
 * safeSend factory:try/catch 包 `webContents.send` 抛框架已知 race 时静默。
 * 5 天 18 次 `Error sending from webFrameMain: Render frame was disposed`
 * 单日 14 次与 Claude Code process SIGKILL 同波(销毁竞态),isDestroyed
 * 守门拦不到 Electron framework 内部 race。仅静默这条已知 race 噪声,其他
 * send 失败(TypeError / 业务 bug)仍 throw 走 errorHandler.startCatching 落盘。
 *
 * 抽到 _deps.ts 让单测可独立 import,无需走 bootstrap-wiring.ts 整个 god-function
 * 副作用链(后者触发 src/main/window/lifecycle.ts:1 named import 'electron' 在
 * vitest CJS interop 下撞 Named export 'BrowserWindow' not found, 详 plan §已知踩坑)。
 */
export function makeSafeSend(getWindow: () => Electron.BrowserWindow | null) {
  return <T>(channel: string, payload: T): void => {
    const w = getWindow();
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    try {
      w.webContents.send(channel, payload);
    } catch (err) {
      if (err instanceof Error && /Render frame was disposed/.test(err.message)) return;
      throw err;
    }
  };
}

/**
 * R3.E9 IPC bridge debouncer:team / message events 16ms debounce + per-team 累加
 * (reviewer claude LOW 收口)。burst 投递时 renderer 不会被高频重渲染。
 *
 * 用法:bootstrap-wiring.ts Phase 9 创建 teamChangedSender / messageChangedSender
 * 两个实例分别绑 IpcEvent.AgentDeckTeamChanged / IpcEvent.AgentDeckMessageChanged。
 */
export function makeDebouncedTeamSender<T>(
  channel: string,
  send: (channel: string, payload: T[]) => void,
  pickKey: (item: T) => string,
): (item: T) => void {
  const state: { pending: Map<string, T>; timer: NodeJS.Timeout | null } = {
    pending: new Map(),
    timer: null,
  };
  return (item: T) => {
    state.pending.set(pickKey(item), item);
    if (state.timer) return;
    state.timer = setTimeout(() => {
      const items = Array.from(state.pending.values());
      state.pending.clear();
      state.timer = null;
      if (items.length === 0) return;
      send(channel, items);
    }, 16);
  };
}

/**
 * archive-toctou-fix-20260515 plan: TOOL_DISPLAY_NAME 从 `Record<string, string>` narrow 到
 * `Record<CallerArchiveFailedToolName, string>` 强制完整覆盖 — 加新 emit 触发点(EventMap toolName
 * union 加值)忘加 TOOL_DISPLAY_NAME 条目时 tsc 编译期 fail(✅ feature),不再走 fallback `??
 * payload.toolName` 软兜底导致 IPC channel 内部名暴露给用户(R2 MED-1 修法的强化版)。
 *
 * 'SessionHandOffSpawn' 是 IPC channel 内部名 (IpcInvoke.SessionHandOffSpawn = 'session:hand-off-spawn',
 * 用户在 UI 看不到),映射成「会话接力」让通知 body 对用户友好,不暴露内部名。
 */
export type CallerArchiveFailedToolName = EventMap['caller-archive-failed'][0]['toolName'];
export const TOOL_DISPLAY_NAME: Record<CallerArchiveFailedToolName, string> = {
  archive_plan: 'plan 归档',
  hand_off_session: '会话接力',
  SessionHandOffSpawn: '会话接力',
};
