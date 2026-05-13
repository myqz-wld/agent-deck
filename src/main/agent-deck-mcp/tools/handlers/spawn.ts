/**
 * spawn_session handler —— 7 大 handler 中最重的一个：
 * - 防御链：external caller deny + sessionRepo caller 反查 + spawn-guards 3 条规则 +
 *   adapter capabilities 校验 + agent body resolve
 * - 持久化链：setSpawnLink + recordCreatedPermissionMode + setTitle +
 *   teamRepo.ensureByName/addMember(lead+teammate) + messageRepo.insert (placeholder)
 * - permission/sandbox 继承（REVIEW_32 HIGH-5）：caller 显式 > lead 继承 > undefined
 * - team-cohesion-fix-20260513 Phase B5/B7：spawn 路径与 wait_reply 贯通的 placeholder + wire prefix
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 432-668 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * 顺手修 MED-1 (fan-out race)：setSpawnLink 提到 try 块内 createSession 之后（旧实现
 * 在 finally release 之后才 setSpawnLink，期间 applySpawnGuards 调用 listChildren 看不到
 * 新 sid + inFlightChildren 已 -1，effective parallel 能突破 maxFanOut + 1）。
 */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { agentDeckTeamRepo, TeamInvariantError } from '@main/store/agent-deck-team-repo';
import { adapterRegistry } from '@main/adapters/registry';
import { getBundledAssetContent } from '@main/bundled-assets';

import { applySpawnGuards } from '../../spawn-guards';
import {
  denyExternalIfNotAllowed,
  err,
  ok,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { SpawnSessionArgs } from '../schemas';

export async function spawnSessionHandler(
  args: SpawnSessionArgs,
  ctx: HandlerContext,
  opts?: { batonMode?: boolean },
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('spawn_session', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  const adapter = adapterRegistry.get(args.adapter);
  if (!adapter || !adapter.createSession) {
    return err(
      `adapter "${args.adapter}" cannot create sessions`,
      'Adapter not registered or createSession not implemented. Check list_sessions to see available adapters.',
    );
  }
  if (!adapter.capabilities.canCreateSession) {
    return err(
      `adapter "${args.adapter}" does not support session creation`,
      'Some adapters (e.g. aider / generic-pty placeholders) are read-only.',
    );
  }

  // 完整防递归 3 条规则（ADR §6 / REVIEW_28 移除 §6.2 cwd cycle 后）：depth 上限 /
  // fan-out / spawn-rate（顺序：不消耗资源的检查前置，详 spawn-guards.ts 头注释）。
  // 任一 deny 立即返回；通过 → 拿到 fanOutSlot，必须在 createSession 完成后（无论成功
  // 失败）调 release()。
  // CHANGELOG_98：透传 opts.batonMode，K2 baton 路径跳过 depth check（其他 guard 保留）
  const guard = applySpawnGuards(caller, args.cwd, args.adapter, {
    batonMode: opts?.batonMode ?? false,
  });
  if ('isError' in guard) return guard;
  const { parentDepth, fanOutSlot } = guard;

  // D1 (CHANGELOG_76): agent_name 非空 → 按 plugin agents registry resolve body file，
  // 把 body 作为 prompt 前缀注入。getBundledAssetContent('agent', name) 已 startup 时
  // loadBundledAssets 预热缓存（main/index.ts:202 step 8.5），现读 fs 一次性拿到。
  // 找不到（拼写错 / 没安装该 plugin）→ 直接 err 防止静默落空 fallback。
  //
  // REVIEW_31 Bug 1+2 修法：getBundledAssetContent 真实签名是 discriminated union
  // `{ok:true,content:string} | {ok:false,reason:string}`，老代码把它当 `string|null`
  // 用，模板字符串 `${object}` toString 成 "[object Object]"，agent body 完全没注入；
  // 测试 mock 也错齐成 string|null 同样错型，单测 100% 通过 / 生产 100% 失败。这里
  // 必须正确解 union，并把 reason 透传给 err 便于 caller 排查。
  let promptToUse = args.prompt;
  if (args.agent_name) {
    const bodyResult = getBundledAssetContent('agent', args.agent_name);
    if (!bodyResult.ok) {
      fanOutSlot.release();
      return err(
        `agent body not found for agent_name="${args.agent_name}": ${bodyResult.reason}`,
        'Plugin agent registry does not include this name. Check Header → 📚 资产库 → Agents tab for available bundled agent names (e.g. "reviewer-claude" / "reviewer-codex"). Spawn aborted to avoid silently falling back to caller prompt without the agent body.',
      );
    }
    // 拼接：body 在前 + 1 行空行分隔 + caller prompt 在后（task body 部分）。
    // 与 SDK system prompt 注入路径不同 —— in-process / HTTP / stdio 都没法直接改 SDK
    // system prompt prefix（adapter API 没暴露 additionalSystemPrompt），所以在
    // user-message 头部注入是最简兼容方案。reviewer-* agent body 顶部已有 frontmatter，
    // body 本身就是给 reviewer 看的「角色提示」，作为 user message 头部仍能起到 priming 作用。
    promptToUse = `${bodyResult.content}\n\n---\n\n${args.prompt}`;
  }

  // REVIEW_32 HIGH-5：spawn 默认继承 lead session 的 permission_mode / codex_sandbox /
  // claude_code_sandbox。caller 显式传则覆盖；external caller (callerExists==false) 不继承
  // 沿用 adapter 默认（避免外部 MCP client 误触发 lead 沙盒透传）。
  // 解决 reviewer-codex 报「外层 Claude Code sandbox 拦了 codex in-process app-server 初始化」
  // 的根因 —— spawn 出的 reviewer-codex teammate 没继承 lead 的 sandbox 设置，跑在受限沙盒里。
  const callerExists = sessionRepo.get(caller.callerSessionId) !== null;
  const leadRecord = callerExists ? sessionRepo.get(caller.callerSessionId) : null;
  const effectivePermissionMode =
    args.permission_mode ?? leadRecord?.permissionMode ?? undefined;
  const effectiveCodexSandbox = args.codex_sandbox ?? leadRecord?.codexSandbox ?? undefined;
  const effectiveClaudeCodeSandbox =
    args.claude_code_sandbox ?? leadRecord?.claudeCodeSandbox ?? undefined;

  // plan team-cohesion-fix-20260513 Phase B7：spawn 路径 wire format 注入 messageId。
  // 流程：先预生成 placeholderId（crypto.randomUUID）→ 拼 `[msg <id>]\n` 到 promptToUse 顶部
  // → createSession 让 SDK 带含 prefix 的 prompt 启动 teammate → 之后 insert placeholder
  // 用预先 id（messageRepo.insert 接受 input.id 可选参数，Phase B7 加）。
  // teammate 收到 prompt 后从顶部 regex `\[msg ([0-9a-f-]+)\]` 提 id 调 reply_message。
  // 无 team / no-shared-team / external caller 场景下不注入 prefix（teammate reply 也无对话锚点）。
  // **注意**：DB messages.body 列存**原始 promptToUse**（不含 prefix），与 send_message
  // 路径同款（buildWireBody 注入 prefix 在 watcher 内存里完成，不写回 DB）；这里 spawn
  // 路径在 createSession 之前用 promptForSpawn 变量保留 wire 形式，DB 仍存 promptToUse。
  // callerExists 提前算（不能等到 createSession 之后再判定 willCreatePlaceholder，否则
  // external caller 仍会拿到含 prefix 的 prompt 但 placeholder 不入 DB → teammate
  // reply_message 用错 id 调用失败）。
  const willCreatePlaceholder = !!args.team_name && callerExists;
  let placeholderId: string | null = null;
  let promptForSpawn = promptToUse; // 给 SDK 的 wire 形式（可能含 [msg <id>] prefix）
  if (willCreatePlaceholder) {
    placeholderId = crypto.randomUUID();
    promptForSpawn = `[msg ${placeholderId}]\n${promptToUse}`;
  }

  // 实际 spawn
  // REVIEW_32 follow-up MED-1 (fan-out race) 修法：把 setSpawnLink 提到 try 块内 createSession
  // 之后，与 fanOutSlot.release()（finally）形成顺序保证。旧实现 release 在 finally 跑完才
  // setSpawnLink → applySpawnGuards 下次调用看到 inFlightChildren=0（已 release）+
  // listChildren=oldCount（新 sid 未 setSpawnLink）→ effective 比真实少 1，能突破 maxFanOut + 1。
  // 新版 setSpawnLink 在 release 之前做完，关闭 race window。
  let sid: string;
  try {
    sid = await adapter.createSession({
      cwd: args.cwd,
      prompt: promptForSpawn, // wire 形式（spawn 路径下若有 team_name 则含 [msg <id>] prefix）
      // REVIEW_32 HIGH-5：使用 effective 字段（caller 显式 > lead 继承 > undefined）
      ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
      ...(effectiveCodexSandbox !== undefined ? { codexSandbox: effectiveCodexSandbox } : {}),
      ...(effectiveClaudeCodeSandbox !== undefined
        ? { claudeCodeSandbox: effectiveClaudeCodeSandbox }
        : {}),
      ...(args.team_name !== undefined ? { teamName: args.team_name } : {}),
    });
    // 仅当 caller 自身在 sessions 表里时记 spawn link（in-process 闭包外 caller 视为顶层）。
    // setSpawnLink 在 release 之前完成，关闭 fan-out race window（详上方 MED-1 注释）。
    // CHANGELOG_98：batonMode=true 时 spawn_depth 写 parentDepth（lateral，不 +1）—
    // baton 单向交接不构成 fork-bomb，depth 累积没意义；连续 baton 链应 stay flat
    // 否则下次以 baton 出来的 session 调普通 spawn 也会撞 depth check（即使 R2 reviewer-codex
    // 警告：单跳 guard 不改 setSpawnLink 仍会让 depth 4/5/... 累积污染后续 spawn）。
    if (callerExists) {
      const newDepth = opts?.batonMode ? parentDepth : parentDepth + 1;
      sessionRepo.setSpawnLink(sid, caller.callerSessionId, newDepth);
    }
  } catch (e) {
    fanOutSlot.release();
    return err(
      e instanceof Error ? e.message : String(e),
      'createSession failed; no session created. Check adapter logs for details.',
    );
  } finally {
    // catch 路径已 release；finally 兜底 idempotent 二次 release（内部 dedupe）
    fanOutSlot.release();
  }

  // REVIEW_32 HIGH-5：用 effective 值持久化（继承自 lead 的也要写 sessionRepo，否则 resume
  // 路径下次拿不到正确 mode）。capability 校验保留 —— 不支持该 capability 的 adapter 跳过。
  if (adapter.capabilities.canSetPermissionMode && effectivePermissionMode) {
    sessionManager.recordCreatedPermissionMode(sid, effectivePermissionMode);
  }

  // REVIEW_31 Bug 4：teammate display name fallback 链 = args.display_name > args.agent_name > 不动。
  // 只有 caller 显式给了一个有意义的名字（display_name / agent_name）才覆盖默认 cwd-basename
  // title —— 否则保留默认行为（avoid 把 agent_name 也强加给那些 caller 没传 agent_name 的「裸 spawn」场景）。
  // teamRepo.addMember 同步把 displayName 写进 team_member 表，wire format buildWireBody 优先取此字段
  // → wire prefix 从 fallback `claude-code:8023f956` 升级为「reviewer-claude」/「reviewer-codex」。
  const teammateDisplayName = args.display_name ?? args.agent_name ?? null;
  if (teammateDisplayName) {
    try {
      sessionRepo.setTitle(sid, teammateDisplayName);
    } catch (e) {
      // 写 title 失败不阻塞 spawn 成功（最坏 fallback 默认 cwd-basename）
      console.warn(`[mcp spawn_session] setTitle(${sid}, ${teammateDisplayName}) failed:`, e);
    }
  }

  // R3.E0 ADR §5.1 amend：team_name 触发 universal team backend ensure-team-by-name
  // + 把 caller 加为 lead + 把新 session 加为 teammate（不再写 sessions.team_name 列）
  let teamId: string | null = null;
  if (args.team_name) {
    try {
      const team = agentDeckTeamRepo.ensureByName(args.team_name, { source: 'mcp' });
      teamId = team.id;
      // caller 自动以 lead role 加入（如已 active 则保留）。caller 不在 sessions 表
      // （external __external__ 等）时跳过。
      if (callerExists) {
        try {
          agentDeckTeamRepo.addMember({
            teamId: team.id,
            sessionId: caller.callerSessionId,
            role: 'lead',
            displayName: null,
          });
          // plan team-cohesion-fix-20260513 Phase A：lead addMember 后触发 session-upserted
          // 让桥点 enrich teams[] → renderer 立即看到 lead 的 🛡 chip（不再等下一个 agent event）。
          sessionManager.notifyTeamMembershipChanged(caller.callerSessionId);
        } catch (e) {
          // 已 active 时 invariant 抛错；视为「已是 lead」幂等成功
          if (!(e instanceof TeamInvariantError)) throw e;
        }
      }
      agentDeckTeamRepo.addMember({
        teamId: team.id,
        sessionId: sid,
        role: 'teammate',
        // REVIEW_31 Bug 4：teammate displayName 同步写 team_member 表，
        // 让 wire format buildWireBody 优先取此名字（不再 fallback 到 `<adapter>:<sid_8>`）。
        displayName: teammateDisplayName,
      });
      // plan team-cohesion-fix-20260513 Phase A Step A7：teammate addMember 后同样触发 session-upserted
      // 让桥点 enrich teams[]（与 lead 路径对称）。
      sessionManager.notifyTeamMembershipChanged(sid);
      // plan team-cohesion-fix-20260513 Phase A Step A8：删 sessionManager.recordCreatedTeamName 调用
      // —— universal team backend addMember 已是 SSOT，不再写老 sessions.team_name 列；
      // v012 migration 后此列彻底 drop。
    } catch (e) {
      console.warn(`[mcp spawn_session] team ensure / addMember failed for "${args.team_name}":`, e);
    }
  }

  // plan team-cohesion-fix-20260513 Phase B5：spawn 路径与 wait_reply 贯通的方案 A 实现 ——
  // spawn 仍把 prompt 给 adapter（SDK streaming 协议要求 first user message），同时在
  // messages 表 enqueue 一条 placeholder message（body=promptToUse, status='delivered'，
  // 不重复投递）作为 lead/teammate 对话链的锚点。lead 拿 spawnPromptMessageId 调
  // wait_reply({message_id})，teammate first turn 完成后调 reply_message(spawnPromptMessageId)
  // 回复，链路统一。无 team / no-shared-team 时不入队 placeholder（spawn 没有可关联的对话场景）。
  // Phase B7：用上面预生成的 placeholderId（与 promptForSpawn 里的 [msg <id>] 一致），
  // body 仍存原始 promptToUse（不含 wire prefix）。
  //
  // 已知 follow-up（REVIEW_32 §Follow-up MED-2）：placeholder enqueue 失败时只 console.warn
  // 但 prompt 已含 [msg <id>] prefix 发出去，teammate 按规约 reply_message → original
  // 找不到 → reply 100% 失败。真修法需要把 insert 提到 createSession 之前 + messageRepo
  // 加 initialStatus='delivered' / updateToSessionId helper（scope 较大），留下次 phase。
  // 当前最小防御：失败时返回 spawnPromptMessageId=null，lead 至少不会调 wait_reply hang。
  let spawnPromptMessageId: string | null = null;
  if (teamId && callerExists && placeholderId) {
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
      console.warn(`[mcp spawn_session] placeholder message enqueue failed:`, e);
    }
  }

  const created = sessionRepo.get(sid);
  return ok({
    sessionId: sid,
    adapter: args.adapter,
    cwd: args.cwd,
    teamId,
    teamName: args.team_name ?? null,
    // REVIEW_32 HIGH-4：spawn-time agent_name / display_name 回传给 caller
    // （deep-code-review SKILL 里 lead 起多组并发 review 时按这两字段区分 reviewer 实例，
    // 不再需要 list_sessions / get_session 反查）。
    agentName: args.agent_name ?? null,
    displayName: teammateDisplayName,
    spawnDepth: created?.spawnDepth ?? (callerExists ? (opts?.batonMode ? parentDepth : parentDepth + 1) : 0),
    sentAt: Date.now(),
    // plan team-cohesion-fix-20260513 Phase B5：lead 用此 messageId 调 wait_reply 等 teammate first reply
    spawnPromptMessageId,
  });
}
