// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.8 拆分:bootstrap god-function 的 wiring 段(原 bootstrap
// Phase 9-11,L282-478)。
//
// 顺序:floating create → safeSend 闭包 → emitCompactChanged 注入 →
// 9 个基础 eventBus.on → caller-archive-failed 复杂 listener(双通道独立 try/catch
// + 3 reasonKind 分流 + TOOL_DISPLAY_NAME narrowing)→ 2 个 debounced team/message
// sender → ensureFocusableOnActivate → 4 个 globalShortcut.register → setImmediate
// handleCliArgv。
//
// caller-archive-failed listener 的复杂处理(R2/R3/archive-toctou-fix-20260515 多
// 次 review 加固)inline 在本文件内,与 wiring 整体一起就近;TOOL_DISPLAY_NAME 与
// CallerArchiveFailedToolName narrowing type 抽到 _deps.ts 集中(archive-toctou-fix
// 强制完整覆盖 invariant 见 _deps.ts 注释)。
// ────────────────────────────────────────────────────────────────────────────

import { globalShortcut } from 'electron';

import { ensureFocusableOnActivate, getFloatingWindow } from '../window';
import { eventBus } from '../event-bus';
import { settingsStore } from '../store/settings-store';
import { sessionManager } from '../session/manager';
import { notifyUser } from '../notify/visual';
import { handleCliArgv } from '../cli';
import { IpcEvent } from '@shared/ipc-channels';

import { makeDebouncedTeamSender, TOOL_DISPLAY_NAME } from './_deps';
import log from '@main/utils/logger';

const logger = log.scope('bootstrap-wiring');

/**
 * bootstrap god-function Phase 9-11 wiring 段。
 * initInfra 返回 ok=true 后由 facade 调用。
 */
export function initWiring(): void {
  const settings = settingsStore.getAll();

  // 9. 创建窗口并把事件总线接到 webContents
  const floating = getFloatingWindow();
  floating.create();
  floating.setWindowTransparent(settings.windowTransparent);
  const safeSend = <T>(channel: string, payload: T): void => {
    const w = floating.window;
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(channel, payload);
  };
  // CHANGELOG_124 R1 fix REVIEW_45 MED-1:toggleMaximize / toggleDefault 退出 compact 态时
  // 通过此回调 emit IpcEvent.CompactToggled,让 renderer App.tsx 同步本地 compact state,
  // 避免按钮 label `{compact ? '▢' : '─'}` 与窗口实际尺寸反转。
  floating.emitCompactChanged = (compact) => safeSend(IpcEvent.CompactToggled, compact);
  eventBus.on('agent-event', (e) => safeSend(IpcEvent.AgentEvent, e));
  // plan team-cohesion-fix-20260513 Phase A:桥到 renderer 前 enrichWithTeams 把 universal team
  // backend membership 拼到 SessionRecord.teams[],让 SessionCard / PendingTab / TeamDetail
  // 拿到 lead/teammate 角色 + teamName 不再依赖老 sessions.team_name 列。
  eventBus.on('session-upserted', (s) => safeSend(IpcEvent.SessionUpserted, sessionManager.enrichWithTeams(s)));
  eventBus.on('session-removed', (id) => safeSend(IpcEvent.SessionRemoved, id));
  eventBus.on('session-renamed', (p) => safeSend(IpcEvent.SessionRenamed, p));
  eventBus.on('summary-added', (s) => safeSend(IpcEvent.SummaryAdded, s));
  eventBus.on('session-focus-request', (sid) => safeSend(IpcEvent.SessionFocusRequest, sid));

  // Task Manager (CHANGELOG_43):tasks 表写操作 → renderer
  eventBus.on('task-changed', (p) => safeSend(IpcEvent.TaskChanged, p));

  // Issue Tracker (plan issue-tracker-mcp-20260529 §Step 3.4.4):issues 表写操作 → renderer。
  // 触发源：mcp report_issue / append_issue_context handler + IPC IssuesUpdate / IssuesSoftDelete /
  // IssuesUndelete / IssuesResolveInNewSession handler + IssueLifecycleScheduler tick (kind='hardDeleted')。
  // 桥接到 IpcEvent.IssueChanged 让 renderer issues-store 实时更新（与 task-changed 同款 1 行桥）。
  eventBus.on('issue-changed', (p) => safeSend(IpcEvent.IssueChanged, p));

  // ─── archive-failure-ux-upthrow-20260515 plan: caller archive 失败 UX 上抛 ───
  // 触发源 3 处:
  // 1. mcp baton-cleanup row-missing 短路 (toolName='archive_plan' / 'hand_off_session', reasonKind='row-missing')
  // 2. mcp baton-cleanup archiveFn 抛错 (toolName 同上, reasonKind='archive-throw')
  // 3. K3 SessionHandOffSpawn archive 抛错或 row-missing (toolName='SessionHandOffSpawn', reasonKind 区分)
  //
  // listener 双通道桥接:
  // - notifyUser({level:'info'}) — macOS 系统通知,settings.enableSystemNotification 开启时显示;
  //   reasonKind 区分文案: 'archive-throw' 提示「可重试归档」/ 'row-missing' 提示「记录已不可用」
  // - safeSend(IpcEvent.CallerArchiveFailed) — IPC 上抛 renderer,P2 enhancement 可挂全局 toast
  //   + 「重试归档」按钮(reasonKind='archive-throw' 显示 / 'row-missing' 仅告知)
  //
  // R2 reviewer-claude HIGH-1 + reviewer-codex HIGH 双方共识守门: listener 顶部必须包 try/catch。
  // notifyUser (visual.ts) 没自己 try/catch — 内部调 settingsStore.getAll / Notification.isSupported /
  // new Notification(...).show / playSoundOnce 任一抛错都会冒泡;safeSend 也没 catch。
  // Node EventEmitter 行为: listener throw 在 sync emit 中会冒泡到 emit 调用方,并阻塞同 emit
  // 上后续 listener。如果 listener throw,baton-cleanup / archiveSourceSessionWithEmit 内的 emitFn
  // 调用会 reject → mcp tool 在核心操作已成功后返回失败 / K3 跳过 session-focus-request + newSid
  // 返回,把「archive 失败 warn-only 不阻塞 caller」硬不变量彻底搞反 (UX 上抛通道反成 UX 倒灌通道)。
  // 修法: listener 顶层 try/catch + console.error 兜底,零成本守住不变量。
  //
  // R2 reviewer-claude MED-1 守门: payload.toolName 含三种值 ('archive_plan' / 'hand_off_session' /
  // 'SessionHandOffSpawn'),其中前两个是 mcp tool 名 (用户在 codex/claude 调用 mcp tool 时熟悉),
  // 'SessionHandOffSpawn' 是 IPC channel 内部名 (IpcInvoke.SessionHandOffSpawn = 'session:hand-off-spawn',
  // 用户在 UI 看不到)。映射成「会话接力」让通知 body 对用户友好,不暴露内部名。
  //
  // archive-toctou-fix-20260515 plan: TOOL_DISPLAY_NAME 抽到 _deps.ts 单源
  // (Record<CallerArchiveFailedToolName, string> narrowing 强制完整覆盖)
  eventBus.on('caller-archive-failed', (payload) => {
    try {
      const shortSid = payload.sessionId.slice(0, 8);
      const toolDisplay = TOOL_DISPLAY_NAME[payload.toolName];
      // body 文案区分 reasonKind 三档:
      // - archive-throw: row 存在但 archive 失败 → 「可重试归档」
      // - probe-throw: DB probe 异常 → 「可稍后重试」(区分 archive-throw 让用户知道是 DB 问题)
      // - row-missing: row 真不存在 → 「记录不可用」(仅告知)
      let body: string;
      if (payload.reasonKind === 'archive-throw') {
        body = `原会话未归档,可重试归档(${shortSid}…,工具:${toolDisplay})`;
      } else if (payload.reasonKind === 'probe-throw') {
        body = `数据库异常无法探针原会话,可稍后重试归档(${shortSid}…,工具:${toolDisplay})`;
      } else {
        body = `原会话记录不可用,归档未完成(${shortSid}…,工具:${toolDisplay})`;
      }
      // R3 reviewer-codex MED-1 修法: 双通道独立 try/catch,避免 notifyUser 同步抛错导致
      // safeSend 不执行 → 双通道桥接退化为单通道 (macOS 通知故障时 renderer IPC 也丢)。
      // 通道 1 (macOS 通知) 与通道 2 (IPC 上抛) 各自独立 try/catch + console.error 兜底。
      try {
        notifyUser({
          title: 'Agent Deck 归档失败',
          body,
          level: 'info',
        });
      } catch (err) {
        logger.error('[caller-archive-failed listener] notifyUser 异常 (吞掉,继续走 IPC 通道):', err);
      }
      try {
        safeSend(IpcEvent.CallerArchiveFailed, payload);
      } catch (err) {
        logger.error('[caller-archive-failed listener] safeSend 异常:', err);
      }
    } catch (err) {
      // 兜底: body 构造或两通道 catch 自身异常,不能冒泡到 emit caller (会反向打崩 baton-cleanup /
      // archiveSourceSessionWithEmit 的 warn-only 不阻塞语义)。console.error 让排查不丢信息。
      logger.error('[caller-archive-failed listener] internal throw (吞掉防撞穿 emit caller):', err);
    }
  });

  // ─── R3.E9 universal team backend → renderer 桥接 ───
  // team 增删改 / member 改:聚合到 IpcEvent.AgentDeckTeamChanged
  // message 状态变迁 / 入队:聚合到 IpcEvent.AgentDeckMessageChanged
  // 16ms debounce + per-team 累加合并(reviewer claude LOW 收口)
  const teamChangedSender = makeDebouncedTeamSender<{ kind: string; teamId: string; payload: unknown }>(
    IpcEvent.AgentDeckTeamChanged,
    safeSend,
    (item) => `${item.kind}:${item.teamId}`,
  );
  eventBus.on('agent-deck-team-created', (team) =>
    teamChangedSender({ kind: 'created', teamId: team.id, payload: team }),
  );
  eventBus.on('agent-deck-team-updated', (team) =>
    teamChangedSender({ kind: 'updated', teamId: team.id, payload: team }),
  );
  eventBus.on('agent-deck-team-deleted', (p) =>
    teamChangedSender({ kind: 'deleted', teamId: p.id, payload: p }),
  );
  eventBus.on('agent-deck-team-member-changed', (p) =>
    teamChangedSender({ kind: `member-${p.kind}`, teamId: p.teamId, payload: p }),
  );

  // plan teamless-dm-20260601 D2：teamId 可空（teamless DM）。dedup key 用 messageId 不含 teamId，
  // 故 null 不影响合并；renderer 收到后整体重拉不解析 payload.teamId（reviewer-claude R2 INFO 确认）。
  const messageChangedSender = makeDebouncedTeamSender<{ kind: string; teamId: string | null; messageId: string; payload: unknown }>(
    IpcEvent.AgentDeckMessageChanged,
    safeSend,
    (item) => `${item.kind}:${item.messageId}`,
  );
  eventBus.on('agent-deck-message-enqueued', (p) =>
    messageChangedSender({ kind: 'enqueued', teamId: p.teamId, messageId: p.id, payload: p }),
  );
  eventBus.on('agent-deck-message-status-changed', (p) =>
    messageChangedSender({ kind: 'status-changed', teamId: p.teamId, messageId: p.id, payload: p }),
  );

  ensureFocusableOnActivate();

  // 10. 全局快捷键:Cmd/Ctrl+Alt+P 切换 pin
  const pinShortcut = 'CommandOrControl+Alt+P';
  const registered = globalShortcut.register(pinShortcut, () => {
    const w = floating.window;
    if (!w || w.isDestroyed()) return;
    const next = !w.isAlwaysOnTop();
    floating.setAlwaysOnTop(next);
    safeSend(IpcEvent.PinToggled, next);
  });
  if (!registered) {
    logger.warn(`[shortcut] failed to register ${pinShortcut} (occupied by another app)`);
  }

  // 10.5 全局快捷键:Cmd/Ctrl+Alt+T 切换「窗口透明」开关
  // Phase 5 Step 5.6(plan mcp-bug-and-feature-batch-20260513):从 transparentWhenPinned
  // 重命名 + 解耦 alwaysOnTop。透明独立切换,不依赖 pin 状态 —— 用户可以在不 pin 时也开透
  // 明(视觉效果是 vibrancy null + CSS frosted)。floating.setWindowTransparent 是 idempotent。
  const transparentShortcut = 'CommandOrControl+Alt+T';
  const transparentRegistered = globalShortcut.register(transparentShortcut, () => {
    const w = floating.window;
    if (!w || w.isDestroyed()) return;
    const next = !(settingsStore.get('windowTransparent') ?? true);
    floating.setWindowTransparent(next);
    safeSend(IpcEvent.TransparentToggled, next);
  });
  if (!transparentRegistered) {
    logger.warn(`[shortcut] failed to register ${transparentShortcut} (occupied by another app)`);
  }

  // 10.6 全局快捷键(CHANGELOG_124):Cmd/Ctrl+Alt+= 一键到屏幕最大、Cmd/Ctrl+Alt+- 一键回默认 520×680
  // 两键各自 toggle:再按一次恢复上次「自定义」尺寸(共享 preferredSize 记忆字段,详 window.ts 内 JSDoc)。
  // 不发 IPC event:窗口尺寸 renderer 不需直接订阅(DOM 自身响应 resize),与 pin/transparent
  // 这种「persistent bool 视觉态」不同,无需双端 state 同步。
  //
  // 注:electron 接受多种 accelerator 写法,'=' 与 'Plus' 等价(同物理键,源码 keyboard_code_conversion.cc
  // 把两者都映射到 VKEY_OEM_PLUS);macOS 上 Cmd+Alt+= 不撞系统快捷键,其他平台 Ctrl+Alt+= 同样空闲。
  // 若未来跨平台实测发现差异可改 'CommandOrControl+Alt+Plus'。
  // globalShortcut.register 返回 false 时仅 warn 不抛错(被其他 app 占用是合理边界);
  // before-quit handler 已统一收尾 globalShortcut.unregisterAll(),新增两键无需单独处理。
  const maximizeShortcut = 'CommandOrControl+Alt+=';
  const maximizeRegistered = globalShortcut.register(maximizeShortcut, () => {
    floating.toggleMaximize();
  });
  if (!maximizeRegistered) {
    logger.warn(`[shortcut] failed to register ${maximizeShortcut} (occupied by another app)`);
  }

  const defaultSizeShortcut = 'CommandOrControl+Alt+-';
  const defaultSizeRegistered = globalShortcut.register(defaultSizeShortcut, () => {
    floating.toggleDefault();
  });
  if (!defaultSizeRegistered) {
    logger.warn(`[shortcut] failed to register ${defaultSizeShortcut} (occupied by another app)`);
  }

  // 11. 首启命令行
  setImmediate(() => {
    void handleCliArgv(process.argv);
  });
}
