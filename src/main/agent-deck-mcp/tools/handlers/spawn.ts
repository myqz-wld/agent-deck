/** spawn_session orchestration: preflight, guards, provider creation, links, teams, and anchor. */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { adapterRegistry } from '@main/adapters/registry';
import type { ForkedSessionHandle, ForkSessionSource } from '@main/adapters/types';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';

import { applySpawnGuards } from '../../spawn-guards';
import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { SpawnSessionArgs, SpawnSessionResult } from '../schemas';
import { shouldWriteSpawnLink } from './spawn-link-guard';
import { persistSpawnLinkFallback } from './spawn-link-registration';
import {
  resolveSpawnModelOptions,
  type SpawnClaudeCodeEffortLevel,
  type SpawnCodexReasoningEffort,
} from './spawn-model-options';
import { resolveSpawnAgent } from './spawn-agent-resolver';
import { finalizeSpawnLimits } from './spawn-limits';
import { buildSpawnPromptContext } from './spawn-prompt';
import { validateSpawnForkPreflight } from './spawn-fork-preflight';
import {
  buildSpawnTargetOptions,
  setSpawnTargetInitialRegistration,
  setSpawnTargetPrompt,
} from './spawn-target-options';
import {
  cleanupEmptySpawnTeam,
  completeSpawnTeamMembership,
  ensureSpawnTeam,
} from './spawn-team';
import log from '@main/utils/logger';
import { createOrdinaryInitialTurn } from '@main/session/continuation-context/initial-turn';
import { executeFreshSession } from '@main/session/continuation-context/fresh-session-executor';
import type { SpawnSessionHandlerOptions } from './spawn-handler-options';
import { resolveSpawnRuntimeControls, validateSpawnRuntimeControls } from './spawn-runtime-controls';

const logger = log.scope('mcp-spawn');

export const spawnSessionHandler = withMcpGuard(
  'spawn_session',
  async (
    args: SpawnSessionArgs,
    ctx: HandlerContext,
    opts?: SpawnSessionHandlerOptions,
  ) => {
    const { caller } = ctx;
    const contextMode = args.contextMode ?? 'fresh';
    if (opts?.handOffMode && contextMode === 'fork') {
      return err(
        'hand_off_session always starts a fresh successor and cannot request contextMode "fork".',
        'Remove contextMode from the internal hand-off request, or call spawn_session directly for a parallel native fork.',
      );
    }

    const adapter = adapterRegistry.get(args.adapter);
    if (!adapter || !adapter.createSession) {
      return err(
        `adapter "${args.adapter}" cannot create sessions`,
        'Choose an adapter value from the tool schema and ensure that adapter is enabled and available in Agent Deck, then retry.',
      );
    }
    if (!adapter.capabilities.canCreateSession) {
      return err(
        `adapter "${args.adapter}" does not support session creation`,
        'Choose an enabled adapter with session-creation capability: claude-code, deepseek-claude-code, codex-cli, or grok-build.',
      );
    }
    const runtimeControlError = validateSpawnRuntimeControls(
      args,
      adapter.capabilities,
    );
    if (runtimeControlError) {
      return err(runtimeControlError.error, runtimeControlError.hint);
    }

    // **REVIEW_85 MED-A (reviewer-claude) + LOW-1 (reviewer-codex)**: applySpawnGuards 下移到
    // 「所有 createSession 前的纯计算 + 可抛 DB 读」之后。
    // - MED-A: 旧实现 guard 先同步 inc fanOutSlot,但 release 只在下方 createSession 的 try/finally
    //   —— 中间 `leadRecord = sessionRepo.get()` 等裸 DB 读抛错(SQLITE_BUSY / I/O)会越过 handler
    //   永久泄漏 in-flight 计数(dec 仅 release 一条路径,byParent Map 进程级常驻)。下移后 guard 到
    //   createSession-try 之间无裸 DB 读,泄漏窗口归零。
    // - LOW-1: agentName body resolve 此时已在 guard 前,拼错 agentName 提前 return err 不再消耗
    //   app-wide spawn-rate token。

    // agentName 非空 → resolve a real agent config. Bundled Agent Deck agents have priority,
    // then project agents, then user agents. Claude agents use SDK options.agent/options.agents;
    // Codex TOML agents use app-server developerInstructions plus thread/config fields.
    // 找不到（拼写错 / 没安装 / 用户目录无此 agent）→ 直接 err 防止静默落空 fallback。
    let promptToUse = args.prompt;
    // plan model-wiring-and-handoff-20260514 Step 3.1：agent config `model` 提取。
    // 提取后通过 createSession({ model }) 透传给 SDK，让 reviewer teammate 真正按 frontmatter
    // 标的 provider model 跑（修前 model 字段死字段，详 plan Context 第 1 项）。
    let modelFromAgent: string | undefined;
    let modelReasoningEffortFromAgent: SpawnCodexReasoningEffort | undefined;
    let claudeCodeEffortLevelFromAgent: SpawnClaudeCodeEffortLevel | undefined;
    let developerInstructionsFromAgent: string | undefined;
    let codexSandboxFromAgent: SpawnSessionArgs['codexSandbox'] | undefined;
    let codexConfigOverridesFromAgent: CodexConfigObject | undefined;
    let claudeAgentNameFromAgent: string | undefined;
    let claudeAgentsFromAgent: Record<string, AgentDefinition> | undefined;
    let grokAgentNameFromAgent: string | undefined;
    if (args.agentName) {
      const agent = resolveSpawnAgent(args.agentName, args.adapter, args.cwd);
      if (!agent.ok) return err(agent.error, agent.hint);
      modelFromAgent = agent.model;
      modelReasoningEffortFromAgent = agent.modelReasoningEffort;
      claudeCodeEffortLevelFromAgent = agent.claudeCodeEffortLevel;
      developerInstructionsFromAgent = agent.developerInstructions;
      codexSandboxFromAgent = agent.codexSandbox;
      codexConfigOverridesFromAgent = agent.codexConfigOverrides;
      claudeAgentNameFromAgent = agent.claudeAgentName;
      claudeAgentsFromAgent = agent.claudeAgents;
      grokAgentNameFromAgent = agent.grokAgentName;
    }

    const resolvedModelOptions = resolveSpawnModelOptions(
      args,
      modelFromAgent,
      modelReasoningEffortFromAgent,
      claudeCodeEffortLevelFromAgent,
    );
    if (!resolvedModelOptions.ok) {
      return err(resolvedModelOptions.error, resolvedModelOptions.hint);
    }

    // Spawn 权限 / 沙盒默认值：
    // - caller 显式传参永远最高优先级；
    // - caller 与 target adapter 相同才继承 lead 的 permission/sandbox/extra writable roots；
    // - 跨 adapter spawn 不继承 lead（不同 adapter 的权限/沙盒语义不同），改用 target adapter
    //   默认值。Claude-family 的应用默认是 bypassPermissions（与 NewSessionDialog /
    //   agent-deck new 默认一致）；sandbox 仍留 undefined 让 target adapter 走 settings 全局默认。
    // 这避免 Codex lead spawn Claude teammate 时把目标落回 Claude SDK 默认 "每次询问"。
    // REVIEW_36 LOW-1：sessionRepo.get 单次反查（旧实现 callerExists / leadRecord 各调一次）。
    //
    // **REVIEW_49 R1 follow-up LOW**: `callerExists` 控制 caller-scoped side effects 散落 4 处
    // (grep `[caller-scoped #` anchor 定位 — REVIEW_85 INFO reviewer-claude:删内联行号改引 anchor
    // 名,anchor 是 SSOT,内联行号随每次编辑漂移反成维护负担):
    //   #1/4 spawn-link 写入 (`callerExists && shouldWriteSpawnLink({handOffMode})`)
    //   #2/4 team addMember (caller 加入新 team 当 lead)
    //   #3/4 placeholder message (lead context 注入消息表)
    //   #4/4 spawnDepth fallback (created?.spawnDepth ?? 0)
    // **不变量**:这 4 处都依赖 `callerExists === true` (caller 在 sessions 表) 才执行;
    // external caller / 已 archive 的 caller / 不存在的 sid 一律跳过。未来加新副作用走 `[caller-scoped]`
    // anchor 标记 + 校验 `callerExists` 守门。**抽 helper 评估**: 抽 `applyCallerScopedSideEffects`
    // 单入口 helper 反而复杂 (4 个不同 side effect 各自 try/catch + 错误 propagate + 返回闭包),
    // 当前散落 + anchor 注释比抽 helper 维护负担低。
    const leadRecord = sessionRepo.get(caller.callerSessionId);
    const callerExists = leadRecord !== null;
    const shouldInheritAdapterSettings = leadRecord?.agentId === args.adapter;
    const {
      effectivePermissionMode,
      effectiveSessionMode,
      effectiveCodexSandbox,
      effectiveClaudeCodeSandbox,
      effectiveExtraAllowWrite,
    } = resolveSpawnRuntimeControls({
      args,
      capabilities: adapter.capabilities,
      leadRecord,
      inherit: shouldInheritAdapterSettings,
      codexSandboxFromAgent,
    });

    // Build once before fork preflight. The provisional prompt is replaced in-place after the
    // normal team/reply context is assembled, preserving fresh dispatch field order and values.
    const targetOptions = buildSpawnTargetOptions({
      args,
      prompt: promptToUse,
      effectivePermissionMode,
      effectiveSessionMode,
      effectiveCodexSandbox,
      effectiveClaudeCodeSandbox,
      effectiveExtraAllowWrite,
      modelOptions: resolvedModelOptions.options,
      developerInstructions: developerInstructionsFromAgent,
      codexConfigOverrides: codexConfigOverridesFromAgent,
      claudeAgentName: claudeAgentNameFromAgent,
      claudeAgents: claudeAgentsFromAgent,
      grokAgentName: grokAgentNameFromAgent,
      codexRuntimeAccess: opts?.codexRuntimeAccess,
    });

    let forkSource: ForkSessionSource | null = null;
    if (contextMode === 'fork') {
      const preflight = await validateSpawnForkPreflight({
        callerSessionId: caller.callerSessionId,
        caller: leadRecord,
        adapter,
        target: targetOptions,
      });
      if (!preflight.ok) return preflight.result;
      forkSource = preflight.source;
    }

    // 完整防递归 3 条规则（ADR §6 / REVIEW_28 移除 §6.2 cwd cycle 后）：depth 上限 /
    // fan-out / spawn-rate（顺序：不消耗资源的检查前置，详 spawn-guards.ts 头注释）。
    // 任一 deny 立即返回；通过 → 拿到 fanOutSlot，必须在 createSession 完成后（无论成功
    // 失败）调 release()。
    // plan handoff-no-spawn-guards-20260526 §D4 / §D6:透传 opts.handOffMode,hand-off 路径
    // 完全跳过三道防御 + 不进 in-flight 计数(详 applySpawnGuards jsdoc + spawn-link-guard.ts)
    //
    // **REVIEW_85 MED-A (reviewer-claude) 位置不变量**:guard 必须在「上面所有可抛 DB 读
    // (leadRecord = sessionRepo.get) + agentName config resolve」之后、ensureByName 之前。
    //   - 之后:guard inc fanOutSlot 后到下方 createSession try/finally 之间不能有裸抛点,否则
    //     抛错越过 handler → release 永不执行 → in-flight 计数永久泄漏。leadRecord 上移到 guard
    //     前(本来就在前),ensureByName 块自带 try/catch(L下方),二者之间纯计算 → 泄漏窗口归零。
    //   - 之前:guard deny 时直接 return,若 ensureByName 已先跑会留空 team 孤儿(deny 路径无 cleanup)。
    const guard = applySpawnGuards(caller, args.cwd, args.adapter, {
      handOffMode: opts?.handOffMode ?? false,
    });
    if ('isError' in guard) return guard;
    const { parentDepth, fanOutSlot } = guard;

    // CHANGELOG_100 / plan mcp-tool-simplify-20260514 D9：把 team ensure 提到 createSession 前，
    // 这样 wire prefix + lead context block 注入 prompt 时能用真实 teamId（删 reply_message
    // 后 teammate 必须知道 lead sessionId + teamId 才能 send_message 回 lead）。
    // ensureByName 幂等：已存在 team 直接返回；后续 addMember 调用仍需 sid，留在 createSession
    // 之后做（team_member 表 sessionId FK 必须先存在）。
    //
    // CHANGELOG_100 R2 fix (codex MED-2): ensureByName 提前后 createSession 失败 catch 路径必须
    // cleanup 本次新建的空 team，否则 active team 列表会污染（无 lead / 无 teammate 的孤儿 team）。
    // teamCreatedNow 判定：listAllMembers(team.id).length === 0 表示 ensureByName 刚 INSERT
    // (existing active team 必有 ≥ 1 lead member)。catch 时再次 verify 防并发抢先 addMember。
    const { teamIdEarly, teamCreatedNow } = ensureSpawnTeam(args.teamName);

    // REVIEW_31 Bug 4：teammate display name fallback 链 = args.displayName > args.agentName > 不动。
    // teammateDisplayName 在多处被引用（wire prefix injection / setTitle / addMember / ok return），
    // 提前算供下面 lead context block 注入也能引用 lead displayName 对称信息。
    const teammateDisplayName = args.displayName ?? args.agentName ?? null;
    const leadDisplayName = leadRecord?.title ?? null;

    // plan team-cohesion-fix-20260513 Phase B7 / CHANGELOG_100 D9 升级：spawn 路径
    // wire format 与 buildWireBody 同款 `[from <name> @ <adapter>][msg <id>][sid <senderSid>]`
    // 三段，让 teammate 端 message-row.tsx parseWirePrefix 能识别这条 prompt 也是 cross-session
    // message（带 ↩ chip + lead context block 折叠 disclosure），不被当成"自己输入的 user message"渲染。
    //
    // teammate 收到 prompt 后从顶部 regex `\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]` 提
    // messageId + senderSessionId 双锚点，调
    // send_message({replyToMessageId: msgId, sessionId: senderSid, teamId, text}) 回复 lead。
    // lead context block 显式列出 lead sessionId / teamId / lead displayName + send_message 用法，
    // 让 teammate 不必依赖 wire prefix 解析也能 send_message（双层冗余防 prompt 长度截断 / 协议漂移）。
    //
    // 注入条件：callerExists + 普通 spawn（非 handOffMode）。
    // - team spawn：teamIdEarly 写进 context block + placeholder.teamId
    // - standalone spawn：teamIdEarly=null，context block 明确让 teammate omit teamId，placeholder
    //   写 teamId=null 走 teamless DM reply-chain 校验（CHANGELOG_194）。
    // - handOffMode：仍不注入。hand_off_session 是单向接力，successor 不应 reply 旧 caller。
    // **DB messages.body 列存原始 promptToUse**（不含 prefix / lead context block），与 send_message
    // buildWireBody 同款（wire prefix 在内存里加，不写回 DB）。
    //
    // leadDisplayName fallback：优先取 leadRecord.title（用户 / cwd-basename 默认），缺失时用
    // `<leadAdapter>:<lead-sid 前 8>` 同 buildWireBody.resolveFromDisplayName 的 fallback 形态。
    // 严格说 buildWireBody 优先取 team_member.displayName，但 spawn 路径下 lead addMember 在
    // createSession 之后做（team_member sessionId FK 必须先存在），所以这里只能用 leadRecord.title。
    // teammate 看到的是 lead "first impression" 名字，与之后 send_message reply 看到的可能不同
    // —— 视觉上一致足以让用户识别"是同一个 lead"，无需强一致。
    const {
      shouldWriteNormalSpawnLink,
      willInjectWirePrefix,
      placeholderId,
      promptForSpawn,
    } = buildSpawnPromptContext({
      args,
      caller,
      callerExists,
      leadRecord,
      leadDisplayName,
      promptToUse,
      teamIdEarly,
      handOffMode: opts?.handOffMode,
      suppressLeadContext: opts?.suppressLeadContext,
    });
    setSpawnTargetPrompt(targetOptions, promptForSpawn);
    if (shouldWriteNormalSpawnLink) {
      setSpawnTargetInitialRegistration(targetOptions, {
        spawnLink: {
          parentSessionId: caller.callerSessionId,
          depth: parentDepth + 1,
        },
        hiddenFromHistory: opts?.hideFromHistory === true,
        // session-start ingest is synchronous: once this callback runs, listChildren sees the
        // durable row, so the in-flight reservation must be released to avoid double-counting it.
        onRegistered: () => fanOutSlot.release(),
      });
    }

    // 实际 spawn
    // REVIEW_32 follow-up MED-1 (fan-out race) 修法：把 setSpawnLink 提到 try 块内 createSession
    // 之后，与 fanOutSlot.release()（finally）形成顺序保证。旧实现 release 在 finally 跑完才
    // setSpawnLink → applySpawnGuards 下次调用看到 inFlightChildren=0（已 release）+
    // listChildren=oldCount（新 sid 未 setSpawnLink）→ effective 比真实少 1，能突破 maxFanOut + 1。
    // 新版 setSpawnLink 在 release 之前做完，关闭 race window。
    let sid: string;
    let forkHandle: ForkedSessionHandle | null = null;
    try {
      if (contextMode === 'fork' && forkSource) {
        forkHandle = await adapter.createForkedSession!(forkSource, targetOptions);
        sid = forkHandle.sessionId;
      } else {
        sid = await executeFreshSession(
          targetOptions,
          createOrdinaryInitialTurn(targetOptions.prompt ?? ''),
        );
      }
      // 仅当 caller 自身在 sessions 表里时记 spawn link（in-process 闭包外 caller 视为顶层）。
      // setSpawnLink 在 release 之前完成，关闭 fan-out race window（详上方 MED-1 注释）。
      //
      // **REVIEW_39 方案 1 + plan handoff-no-spawn-guards-20260526 §D1/§D6 (handOffMode 升级 batonMode)**:
      // handOffMode=true 路径**永不写 spawn-link**(spawnedBy=null + spawnDepth=0 默认值),
      // 无论 archiveCaller / adoptTeammates 值(plan §D1 + §D4 + §D6 — 故意推翻 REVIEW_46/47
      // 当年「archiveCaller=false 退化 normal spawn」修法,power-user 自负责任详 §D3)。
      //
      // 修前 bug:hand_off_session archiveCaller=false 路径走 normal spawn 写新 session.spawnedBy=
      // callerSid,SessionList Phase C(CHANGELOG_77)按 spawnedBy 树形分组渲染 ↳ teammate badge。
      // 数据层不应记录 spawn-link 假装是 spawn 派遣关系(hand-off-session.ts:21-39 jsdoc 设计
      // 意图明文「不是派出小弟干活」)。
      //
      // 历史名词 `batonMode` 已 rename `handOffMode`(plan §D6)+ 语义升级(原仅跳 depth →
      // 现跳三道 + 永不写 spawn-link)。历史 REVIEW_39/46/47/48 出现的 batonMode 同义于现
      // handOffMode。
      //
      // 副作用范围(已逐一验证无影响):
      // - LineageSection.tsx 仅画 active team members(leftAt === null);hand-off default 不传
      //   teamName → 新 session 不入 team → LineageSection 不渲染 → 无影响
      // - list_sessions(spawnedByFilter) 救火针对 reviewer 派活路径,不针对 hand-off 路径
      //   (default archiveCaller=true 后 caller 已 archive 退出,无人捡 hand-off child)
      // - PendingTab 用 session.teams[] 不用 spawnedBy → 无影响
      // - SessionDetail / TeamDetail 不引用 spawnedBy → 无影响
      // - spawn-guards.ts depth check 用 callerSession.spawnDepth 不用新 session.spawnDepth
      //   → 无影响
      // **[caller-scoped #1/4]** spawn-link 写入(grep anchor 详 L148-160 callerExists 定义)
      if (shouldWriteNormalSpawnLink) {
        persistSpawnLinkFallback({
          sessionId: sid,
          parentSessionId: caller.callerSessionId,
          depth: parentDepth + 1,
        });
      }
    } catch (e) {
      fanOutSlot.release();
      // CHANGELOG_100 R2 fix (codex MED-2): createSession 失败 → cleanup 本次新建的空 team
      // 防 active team 列表污染。再次 verify 空才删（防并发 caller 已抢先 addMember）。
      cleanupEmptySpawnTeam({
        teamCreatedNow,
        teamIdEarly,
        failureLabel: 'createSession failure',
      });
      return err(
        e instanceof Error ? e.message : String(e),
        contextMode === 'fork'
          ? `No forked session was registered. Fix the ${args.adapter} native-fork condition in the error, or retry with contextMode "fresh". If it still fails, inspect Agent Deck logs.`
          : `No session was created. Retry once with an exact catalog/provider model and a thinking value supported by ${args.adapter}, or omit model/thinking. If it still fails, verify adapter authentication and inspect Agent Deck logs.`,
      );
    } finally {
      // catch 路径已 release；finally 兜底 idempotent 二次 release（内部 dedupe）
      fanOutSlot.release();
    }

    // REVIEW_32 HIGH-5：用 effective 值持久化（继承自 lead 的也要写 sessionRepo，否则 resume
    // 路径下次拿不到正确 mode）。capability 校验保留 —— 不支持该 capability 的 adapter 跳过。
    //
    // **REVIEW_85 MED-B (reviewer-claude)**: 包 try/catch 与 sibling post-createSession 副作用
    // (setTitle / addMember / placeholder) 一致。recordCreatedPermissionMode → lifecycle
    // recordCreatedPermissionModeImpl 内 setPermissionMode(DB 写) + sessionRepo.get(DB 读) +
    // eventBus.emit('session-upserted')(同步派发监听器,任一监听器抛会冒泡)三处可抛。修前裸调
    // 抛错会越过 handler → caller 收 MCP error 拿不到 sessionId,而 SDK 子进程已起 → 孤儿活
    // session + caller 可能重试重复 spawn。permissionMode 持久化失败最坏 fallback 默认 mode,
    // 远比孤儿活 session 轻 → 失败仅 warn 不阻塞 spawn 成功返回。
    if (adapter.capabilities.canSetPermissionMode && effectivePermissionMode) {
      try {
        sessionManager.recordCreatedPermissionMode(sid, effectivePermissionMode);
      } catch (e) {
        logger.warn(
          `[mcp spawn_session] recordCreatedPermissionMode(${sid}, ${effectivePermissionMode}) failed:`,
          e,
        );
      }
    }

    // REVIEW_31 Bug 4：teammate display name fallback 链 = args.displayName > args.agentName > 不动。
    // 只有 caller 显式给了一个有意义的名字（displayName / agentName）才覆盖默认 cwd-basename
    // title —— 否则保留默认行为（avoid 把 agentName 也强加给那些 caller 没传 agentName 的「裸 spawn」场景）。
    // teamRepo.addMember 同步把 displayName 写进 team_member 表，wire format buildWireBody 优先取此字段
    // → wire prefix 从 fallback `claude-code:8023f956` 升级为「reviewer-claude」/「reviewer-codex」。
    // CHANGELOG_100 D9: teammateDisplayName 在前面已算（spawn 前注入 lead context block 也用到）；
    // 这里只负责 setTitle 副作用。
    if (teammateDisplayName) {
      try {
        sessionRepo.setTitle(sid, teammateDisplayName);
      } catch (e) {
        // 写 title 失败不阻塞 spawn 成功（最坏 fallback 默认 cwd-basename）
        logger.warn(`[mcp spawn_session] setTitle(${sid}, ${teammateDisplayName}) failed:`, e);
      }
    }

    const teamMembership = await completeSpawnTeamMembership({
      teamName: args.teamName,
      teamIdEarly,
      teamCreatedNow,
      caller,
      callerExists,
      sid,
      teammateDisplayName,
      batonRole: opts?.batonRole,
    });
    if (!teamMembership.ok) {
      if (forkHandle) {
        try {
          await forkHandle.discard();
        } catch (error) {
          logger.warn(`[mcp spawn_session] native fork discard after team failure failed for ${sid}:`, error);
        }
      }
      return teamMembership.result;
    }
    const teamId = teamMembership.teamId;

    // plan team-cohesion-fix-20260513 Phase B5：spawn 路径与 send_message 贯通的方案 A 实现 ——
    // spawn 仍把 prompt 给 adapter（SDK streaming 协议要求 first user message），同时在
    // messages 表 enqueue 一条 placeholder message（body=promptToUse, status='delivered'，
    // 不重复投递）作为 lead/teammate 对话链的锚点。lead 不再主动 poll reply（CHANGELOG_100 删旧 tool）；
    // teammate first turn 完成后调 send_message({replyToMessageId: spawnPromptMessageId, ...})
    // 回复，reply 自动 dispatch 进 lead conversation（J fix 删，CHANGELOG_100）。
    // Standalone spawns also get a placeholder with teamId=null. send_message replies then resolve
    // to teamless DM and pair-scope against this placeholder.
    // Phase B7：用上面预生成的 placeholderId（与 promptForSpawn 里的 [msg <id>] 一致），
    // body 仍存原始 promptToUse（不含 wire prefix）。
    //
    // 已知 follow-up（REVIEW_32 §Follow-up MED-2）：placeholder enqueue 失败时只 console.warn
    // 但 prompt 已含 [msg <id>] prefix 发出去，teammate 按规约 send_message → original
    // 找不到 → reply 100% 失败。真修法需要把 insert 提到 createSession 之前 + messageRepo
    // 加 initialStatus='delivered' / updateToSessionId helper（scope 较大），留下次 phase。
    // 当前最小防御：失败时返回 spawnPromptMessageId=null，lead 至少不会等一个不存在的 reply anchor。
    let spawnPromptMessageId: string | null = null;
    // **[caller-scoped #3/4]** placeholder message(grep anchor 详 L148-160 callerExists 定义)
    if (willInjectWirePrefix && callerExists && placeholderId) {
      try {
        const placeholder = agentDeckMessageRepo.insert({
          id: placeholderId,
          teamId,
          fromSessionId: caller.callerSessionId,
          toSessionId: sid,
          body: promptToUse,
          replyToMessageId: null,
        });
        // 立即 mark delivered：SDK 已通过 createSession.prompt 收过这条 prompt，watcher 不需重投
        agentDeckMessageRepo.markDelivered(placeholder.id, Date.now());
        spawnPromptMessageId = placeholder.id;
      } catch (e) {
        // placeholder enqueue 失败不阻塞 spawn 成功（lead 可走老路径不 wait reply）
        logger.warn(`[mcp spawn_session] placeholder message enqueue failed:`, e);
      }
    }

    const created = sessionRepo.get(sid);
    const spawnDepth =
      created?.spawnDepth ??
      (callerExists && shouldWriteSpawnLink({ handOffMode: opts?.handOffMode })
        ? parentDepth + 1
        : 0);
    const spawnLimits = finalizeSpawnLimits(guard.spawnLimits, {
      callerSessionId: caller.callerSessionId,
      spawnDepth,
    });
    return ok({
      sessionId: sid,
      adapter: args.adapter,
      cwd: args.cwd,
      teamId,
      teamName: args.teamName ?? null,
      // REVIEW_32 HIGH-4：spawn-time agentName / displayName 回传给 caller
      // （deep-review SKILL 里 lead 起多组并发 review 时按这两字段区分 reviewer 实例，
      // 不再需要 list_sessions / get_session 反查）。
      agentName: args.agentName ?? null,
      displayName: teammateDisplayName,
      // **[caller-scoped #4/4]** spawnDepth fallback (grep anchor 详 L148-160 callerExists 定义)
      spawnDepth,
      spawnLimits,
      sentAt: Date.now(),
      // plan team-cohesion-fix-20260513 Phase B5：lead 用此 messageId 作为 teammate first reply anchor
      spawnPromptMessageId,
      ...(contextMode === 'fork'
        ? {
            contextMode: 'fork' as const,
            forkedFromSessionId: caller.callerSessionId,
          }
        : {}),
    } satisfies SpawnSessionResult);
  },
);
