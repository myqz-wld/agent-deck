/**
 * makeCanUseTool — Claude SDK canUseTool 回调工厂（CHANGELOG_52 Step 3c）。
 *
 * 抽自 sdk-bridge.ts createSession 内的 canUseTool 巨型 callback (~275 行)。
 * 按 toolName 分支：READ_ONLY 白名单 / SandboxNetworkAccess auto-deny / AskUserQuestion /
 * ExitPlanMode / 默认权限请求。class state 通过 MakeCanUseToolDeps 注入。
 *
 * 护栏（不变，全部完整保留）：
 * - REVIEW_11 Bug 4 — READ_ONLY_TOOLS / __ImageRead 后缀白名单（任何 permissionMode 下放行）
 * - REVIEW_14/15 — SandboxNetworkAccess auto-deny + 结构化 message 引导 model fallback
 * - REVIEW_11 Bug 3 — approve+plan 走 deny+message 不走 allow（避免 plan→deny→plan 死循环 + setPermissionMode race）
 * - CHANGELOG_34 — approve-bypass deny+interrupt:true（不能 allow）
 * - CHANGELOG_72 Bug 3 — bypassPermissions 模式下默认路径短路 allow（避免 SDK 仍 invoke canUseTool 弹审批）
 * - 超时 timer + ctx.signal abort listener 在 entry.resolver 内 clearTimeout，确保不重复触发
 */
import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  AskUserQuestionItem,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  PermissionRequest,
} from '@shared/types';
import type { PermissionMode } from '@main/adapters/types';
import { formatAskAnswers } from '@main/adapters/claude-code/sdk-bridge-helpers';
import { AGENT_ID, READ_ONLY_TOOLS } from './constants';
import type {
  InternalSession,
  PendingAskQuestionEntry,
  PendingExitPlanModeEntry,
  PendingPermissionEntry,
  SdkBridgeOptions,
} from './types';
import type { PermissionResponder } from './permission-responder';

export interface MakeCanUseToolDeps {
  /** Per-session state（pending Maps / toolUseNames / 等） */
  readonly internal: InternalSession;
  /**
   * 实时取 sessionId（createSession 阶段 internal.realSessionId 还没拿到 → 用 tempKey 兜）。
   * lazy getter 让 canUseTool 第一次被调用时（必然在 waitForRealSessionId 之后）能拿到 realId。
   */
  readonly getSessionId: () => string;
  /**
   * 实时取 in-memory permission mode（CHANGELOG_72 Bug 3）。bypass 短路读这里、不查 sessionRepo。
   *
   * 与 SDK options.permissionMode + InternalSession.permissionMode 同源（createSession 创建 internal
   * 时初始化 / setPermissionMode 同步更新 / restart 走 close+create 自然带新值）。
   */
  readonly getPermissionMode: () => PermissionMode;
  readonly emit: SdkBridgeOptions['emit'];
  /** 实时取超时阈值（用 getter 让运行时 setPermissionTimeoutMs 改了也能拿到新值） */
  readonly getPermissionTimeoutMs: () => number;
  /** 注册 setTimeout callback（与 responder.timeoutXxx 一致） */
  readonly responder: PermissionResponder;
}

export function makeCanUseTool(deps: MakeCanUseToolDeps): CanUseTool {
  const { internal, getSessionId, getPermissionMode, emit, getPermissionTimeoutMs, responder } =
    deps;

  return async (toolName, input, ctx) => {
    const realId = getSessionId();
    const requestId = randomUUID();

    // REVIEW_11 Bug 4：read-only 工具白名单，任何 permissionMode 下都直接放行。
    // SDK 0.2.x 设计：注册 canUseTool 后，CLI 对所有工具调用都丢给应用决策（包括 Read /
    // Grep / Glob / LS / WebFetch / WebSearch / TodoWrite / NotebookRead 这些只读 / 元数据类
    // 工具）。应用之前没做白名单 → default mode 下用户被 Read / Grep 等无害操作反复弹询问，
    // 体感「default mode 跟 plan mode 没区别都要审核」。
    // 白名单内的工具语义上不会改变文件系统 / 不会执行外部命令，截胡放行无安全风险，且与
    // SDK 行为不冲突（SDK 文档明确：注册 canUseTool 即表示决定权完全归应用）。
    // MCP 图片读取类工具（命名约定 mcp__xxx__ImageRead 或后缀 __ImageRead）同样白名单。
    if (READ_ONLY_TOOLS.has(toolName) || toolName.endsWith('__ImageRead')) {
      return { behavior: 'allow', updatedInput: input };
    }

    // REVIEW_14 阶段 2 + REVIEW_15 实证：SandboxNetworkAccess 自动透明 deny。
    //
    // 实测机制（dev 验证 [canusetool] log + 用户给 proxy `403 + X-Proxy-Error:
    // blocked-by-allowlist` 头实证）：
    // sandbox 启用后 SDK 网络拦截是**双层并行**：
    //
    // 1. **应用层 SandboxNetworkAccess 工具回路**：SDK 调内置 `SandboxNetworkAccess`
    //    工具向 canUseTool 申请「是否放行该 host」（payload `{host: 'example.com'}`）
    // 2. **OS/proxy 层执行**：SDK 同时启本地 HTTP CONNECT proxy + 注入 `https_proxy`
    //    env，按 allowedDomains allowlist 实际拦截（curl 拿 `403 Forbidden`）
    //
    // 不修法走 SDK 默认行为时，SandboxNetworkAccess 工具会**弹给用户审批每个 host**
    //（spike 阶段实测见用户截图），加上 model fallback `dangerouslyDisableSandbox: true`
    // 那次的 Bash 弹框，用户视角是「同一个 curl 弹两次」，UX 噪声大、语义还相反。
    //
    // 修法（本分支）：第 1 次直接 deny + 结构化 message → model **100% 按指引**
    // fallback 走 dangerouslyDisableSandbox 重试（不是概率性 reasoning，是协议级稳定路径）
    // → 第 2 次 Bash 弹给用户审批（保留这一次是合理的：model 主动绕沙盒确实需要用户拍板）。
    // 实测 UX：仅 1 次弹框给用户。
    //
    // strict 档因 `allowUnsandboxedCommands: false` 直接封死逃逸路径，model fallback
    // dangerouslyDisableSandbox 也会被 SDK 直接忽略，最终 model 报「无法联网」给用户
    // —— 此分支同样适用，不弹给用户。
    if (toolName === 'SandboxNetworkAccess') {
      const host =
        typeof (input as { host?: unknown })?.host === 'string'
          ? (input as { host: string }).host
          : '<unknown>';
      // 保留此 log 一行：sandbox 启用时每次 host 拦截打一行，可见性高、噪声可控
      // （比每次 canUseTool 都打 log 强）。出问题时一目了然「sandbox 真在拦哪些 host」。
      console.log(
        `[sandbox-canusetool] SandboxNetworkAccess intercept host=${host} → auto-deny + fallback hint`,
      );
      return {
        behavior: 'deny',
        message:
          `网络访问被沙盒拦截（host: ${host}）。如确实需要联网，请用 Bash + ` +
          `dangerouslyDisableSandbox: true 参数重试（会触发用户审批）。` +
          `如档位为 strict 则逃逸已被禁用，请告知用户切档位或换无网方案。`,
        interrupt: false,
      };
    }

    // 特殊路径：AskUserQuestion 不是「危险工具需要批准」，是 Claude 主动征询用户。
    // 走独立 UI（带选项按钮）→ 用户选完 → 把答案塞进 deny.message 反馈给 Claude
    // （Claude 收到 tool_result 含答案，会基于这个继续对话）。
    if (toolName === 'AskUserQuestion') {
      const inAsked = (input as { questions?: AskUserQuestionItem[] }) ?? {};
      const questions = Array.isArray(inAsked.questions) ? inAsked.questions : [];
      // REVIEW_35 LOW-C-codex: SDK 类型是 `toolUseID` 不是 `tool_use_id`（snake_case typo）。
      // 实测 ctx 字段读不出 → AskUserQuestion / ExitPlanMode payload 的 toolUseId 永远 undefined。
      // UI 主要靠 requestId 响应不致命，但破坏 activity/tool 关联能力。优先读 toolUseID 兼容老 tool_use_id。
      const toolUseId =
        (ctx as { toolUseID?: string }).toolUseID ??
        (ctx as { tool_use_id?: string }).tool_use_id;
      const askPayload: AskUserQuestionRequest = {
        type: 'ask-user-question',
        requestId,
        toolUseId,
        questions,
      };
      emit({
        sessionId: realId,
        agentId: AGENT_ID,
        kind: 'waiting-for-user',
        payload: askPayload,
        ts: Date.now(),
        source: 'sdk',
      });
      return new Promise<PermissionResult>((resolve) => {
        const entry: PendingAskQuestionEntry = {
          payload: askPayload,
          timer: null,
          resolver: (answer) => {
            if (entry.timer) clearTimeout(entry.timer);
            const text = formatAskAnswers(questions, answer);
            resolve({
              behavior: 'deny',
              message:
                `用户已通过 UI 选择，请把以下回答视为他们对这次 AskUserQuestion 的回复，` +
                `继续按用户意图执行：\n\n${text}`,
              interrupt: false,
            });
          },
        };
        internal.pendingAskUserQuestions.set(requestId, entry);
        // 超时自动拒：避免 SDK 永远卡在等用户回答（窗口关掉 / store 丢状态等）。
        const timeoutMs = getPermissionTimeoutMs();
        if (timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            responder.timeoutAskUserQuestion(realId, requestId);
          }, timeoutMs);
        }
        ctx.signal?.addEventListener('abort', () => {
          const cur = internal.pendingAskUserQuestions.get(requestId);
          if (cur) {
            if (cur.timer) clearTimeout(cur.timer);
            internal.pendingAskUserQuestions.delete(requestId);
            // 通知 UI：这条提问已被 SDK 取消（通常是 query 流终止 / 上层 interrupt）。
            // 不发也行，但 UI 会一直显示选项却点了没用。
            emit({
              sessionId: realId,
              agentId: AGENT_ID,
              kind: 'waiting-for-user',
              payload: { type: 'ask-question-cancelled', requestId },
              ts: Date.now(),
              source: 'sdk',
            });
            resolve({ behavior: 'deny', message: 'aborted', interrupt: true });
          }
        });
      });
    }

    // 特殊路径：ExitPlanMode —— plan mode 下 Claude 完成规划，向用户提议「请批准执行」。
    // 跟 AskUserQuestion 一样走独立通路：UI 用 markdown 渲染 plan + 二选一按钮。
    // - 批准（approve）→ allow + updatedInput 不变，CLI 内部退出 plan mode 开始执行
    // - 继续规划（keep-planning）→ deny + message（含可选用户反馈），Claude 留在 plan mode 修
    if (toolName === 'ExitPlanMode') {
      const inExit = (input as { plan?: unknown }) ?? {};
      const plan = typeof inExit.plan === 'string' ? inExit.plan : '';
      // REVIEW_35 LOW-C-codex: 同上 toolUseID typo 修法
      const toolUseId =
        (ctx as { toolUseID?: string }).toolUseID ??
        (ctx as { tool_use_id?: string }).tool_use_id;
      const exitPayload: ExitPlanModeRequest = {
        type: 'exit-plan-mode',
        requestId,
        toolUseId,
        plan,
      };
      emit({
        sessionId: realId,
        agentId: AGENT_ID,
        kind: 'waiting-for-user',
        payload: exitPayload,
        ts: Date.now(),
        source: 'sdk',
      });
      return new Promise<PermissionResult>((resolve) => {
        const entry: PendingExitPlanModeEntry = {
          payload: exitPayload,
          toolInput: (input as Record<string, unknown>) ?? {},
          timer: null,
          resolver: (response) => {
            if (entry.timer) clearTimeout(entry.timer);
            if (response.decision === 'approve' && response.targetMode === 'plan') {
              // REVIEW_11 Bug 3：「批准并保持 Plan 模式」是协议级特例。
              // SDK / CLI 把「ExitPlanMode 工具被 allow」语义性视为「用户同意退出 plan」，
              // 一旦 allow，CLI 内部状态机立刻翻出 plan，外层后续 setPermissionMode('plan')
              // 跑在 CLI 已退档之后属于 CHANGELOG_47 同病灶（post-allow 时序静默吞档）。
              // 修法：approve+plan 不走 allow，改 deny+message：让 CLI 留在 plan 不退档，
              // 同时通过 message 告诉 Claude「计划已被认可，但用户希望继续在 plan 模式推进」。
              // message 文案要明确「不要立刻再次调用 ExitPlanMode」避免 plan→deny→plan 死循环。
              resolve({
                behavior: 'deny',
                message:
                  `用户已认可你的计划，但要求你继续在 plan 模式下推进` +
                  `（继续细化方案 / 补充信息 / 等待进一步指示，**不要执行任何编辑或写入操作**）。\n\n` +
                  `如果用户后续要求实施，请等他们主动切换到 default / acceptEdits / bypass 之后再操作，` +
                  `**不要在本会话内立刻再次调用 ExitPlanMode**（用户还想停留在 plan 模式继续讨论）。`,
                interrupt: false,
              });
            } else if (response.decision === 'approve') {
              // 热切档（approve + targetMode ∈ {default, acceptEdits}）：
              // allow + 原 input 透传 —— 让 ExitPlanMode 工具调用「成功」，
              // CLI 收到 tool_result 自动退出 plan mode，后续工具按 targetMode 继续
              // （targetMode 由外层 respondExitPlanMode 在 resolver 后同步调
              // s.query.setPermissionMode(targetMode) + sessionRepo 写入；
              // SDK Query 在下次工具调用前应用新 mode）。
              resolve({
                behavior: 'allow',
                updatedInput: entry.toolInput,
              });
            } else if (response.decision === 'approve-bypass') {
              // 冷切档：deny + interrupt:true —— 让 OLD CLI 子进程的当前 turn 立即中止，
              // 避免「allow 后 SDK 立刻吐 tool_use 跟正在重启的子进程抢 jsonl flush」race
              // （双 Agent 对抗一致结论；race 触发后用户体感「批准了 plan 但 NEW session 又
              // 重新进 plan mode」，磁盘 IO 抖动导致无法稳定复现）。
              // OLD turn 中止后由外层 respondExitPlanMode 调 restartWithPermissionMode，
              // 用 plan 文本作 handoff prompt 让 Claude 在 bypass 模式重新执行。
              resolve({
                behavior: 'deny',
                message: '用户已批准 plan 并切换到 bypassPermissions 模式，正在重启子进程重新执行',
                interrupt: true,
              });
            } else {
              // keep-planning：保留原逻辑
              const fb = response.feedback?.trim();
              resolve({
                behavior: 'deny',
                message:
                  `用户希望继续完善计划，请基于以下反馈修改后再调用 ExitPlanMode 提交新版本：\n\n` +
                  `反馈：${fb || '(用户未填写具体反馈，请主动询问需要补充哪方面)'}`,
                interrupt: false,
              });
            }
          },
        };
        internal.pendingExitPlanModes.set(requestId, entry);
        const timeoutMs = getPermissionTimeoutMs();
        if (timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            responder.timeoutExitPlanMode(realId, requestId);
          }, timeoutMs);
        }
        ctx.signal?.addEventListener('abort', () => {
          const cur = internal.pendingExitPlanModes.get(requestId);
          if (cur) {
            if (cur.timer) clearTimeout(cur.timer);
            internal.pendingExitPlanModes.delete(requestId);
            emit({
              sessionId: realId,
              agentId: AGENT_ID,
              kind: 'waiting-for-user',
              payload: { type: 'exit-plan-cancelled', requestId },
              ts: Date.now(),
              source: 'sdk',
            });
            resolve({ behavior: 'deny', message: 'aborted', interrupt: true });
          }
        });
      });
    }

    // CHANGELOG_72 Bug 3：bypassPermissions 模式默认路径直接 allow，避免 SDK 仍 invoke canUseTool
    // 弹审批给用户（实测 b81c509b 17:00:06 sql 铁证：sessions.permission_mode='bypassPermissions'
    // 但 Write 仍被推到 PendingTab）。SDK 注释只描述「allowDangerouslySkipPermissions 是启用门栓」，
    // 没承诺 spawn-time 设置后 SDK 不再调 canUseTool —— 应用层主动短路是 SDK 设计意图允许的、
    // 也是唯一可行的修法（取消注册 canUseTool 会同时砸掉 READ_ONLY 白名单 / SandboxNetworkAccess
    // auto-deny / AskUserQuestion / ExitPlanMode 四条护栏）。
    //
    // 插点：所有特殊工具分支（READ_ONLY 白名单 / SandboxNetworkAccess auto-deny / AskUserQuestion
    // 走 UI / ExitPlanMode 走 UI）之后、默认路径前 —— bypass 不绕开任何特殊路径：
    // - SandboxNetworkAccess：auto-deny 是沙盒语义独立护栏，bypass 模式仍要拒（与 settings
    //   claudeCodeSandbox 用户开关语义解耦）
    // - AskUserQuestion：Claude 主动询问语义不属"危险工具需审批"，应保留 UI 通路
    // - ExitPlanMode：plan + bypass 互斥，但运行时进入此分支表示热切场景，保留三态 resolver
    //
    // 短路读 `getPermissionMode()` (= internal.permissionMode in-memory cache，与 SDK options
    // 同源) —— 不查 sessionRepo —— 关键：避免 createSession 期间 sessionRepo.permission_mode
    // 还没被 recordCreatedPermissionMode 写库（adapters.ts:159 await createSession → :176 才 record）
    // 的 race，让 bypass 会话首条 prompt 触发的工具调用就能正确短路。
    if (getPermissionMode() === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input };
    }

    // 默认路径：普通工具的权限请求 → 弹给用户决策
    const permPayload: PermissionRequest = {
      type: 'permission-request',
      requestId,
      toolName,
      toolInput: input as Record<string, unknown>,
      suggestions: ctx.suggestions,
    };
    emit({
      sessionId: realId,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: permPayload,
      ts: Date.now(),
      source: 'sdk',
    });
    return new Promise<PermissionResult>((resolve) => {
      const entry: PendingPermissionEntry = {
        payload: permPayload,
        resolver: resolve,
        timer: null,
      };
      internal.pendingPermissions.set(requestId, entry);
      const timeoutMs = getPermissionTimeoutMs();
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          responder.timeoutPermission(realId, requestId);
        }, timeoutMs);
      }
      ctx.signal?.addEventListener('abort', () => {
        const cur = internal.pendingPermissions.get(requestId);
        if (cur) {
          if (cur.timer) clearTimeout(cur.timer);
          internal.pendingPermissions.delete(requestId);
          // 通知 UI：SDK 已放弃这次请求（超时 / interrupt / 流终止），
          // 让活动流和 banner 把这条权限请求清掉，不再让用户点了没反应。
          emit({
            sessionId: realId,
            agentId: AGENT_ID,
            kind: 'waiting-for-user',
            payload: { type: 'permission-cancelled', requestId },
            ts: Date.now(),
            source: 'sdk',
          });
          resolve({ behavior: 'deny', message: 'aborted', interrupt: true });
        }
      });
    });
  };
}
