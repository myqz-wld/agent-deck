/**
 * spawn_session handler —— 7 大 handler 中最重的一个：
 * - 防御链：external caller deny + sessionRepo caller 反查 + spawn-guards 3 条规则 +
 *   adapter capabilities 校验 + agent body resolve
 * - 持久化链：setSpawnLink + recordCreatedPermissionMode + setTitle +
 *   teamRepo.ensureByName/addMember(lead+teammate) + messageRepo.insert (placeholder)
 * - permission/sandbox 默认值：caller 显式 > same-adapter lead 继承 > target adapter 默认
 * - team-cohesion-fix-20260513 Phase B5/B7：spawn 路径与 reply chain 贯通的 placeholder + wire prefix
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
import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import { eventBus } from '@main/event-bus';
import { getBundledAssetContent } from '@main/bundled-assets';
import { parseFrontmatter } from '@main/utils/frontmatter';
import { omitUndefined } from '@main/utils/optional-fields';

import { applySpawnGuards } from '../../spawn-guards';
import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { SpawnSessionArgs, SpawnSessionResult } from '../schemas';
import { shouldWriteSpawnLink } from './spawn-link-guard';
import { buildLeadContextBlock } from './lead-context-block';
import log from '@main/utils/logger';

const logger = log.scope('mcp-spawn');

function defaultPermissionModeForTargetAdapter(
  adapter: SpawnSessionArgs['adapter'],
): 'bypassPermissions' | undefined {
  if (adapter === 'claude-code' || adapter === 'deepseek-claude-code') {
    return 'bypassPermissions';
  }
  return undefined;
}

export const spawnSessionHandler = withMcpGuard(
  'spawn_session',
  async (
    args: SpawnSessionArgs,
    ctx: HandlerContext,
    opts?: { handOffMode?: boolean; batonRole?: 'lead' | 'teammate' },
  ) => {
    const { caller } = ctx;

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
        'Adapter has capabilities.canCreateSession=false (read-only adapter).',
      );
    }

    // **REVIEW_85 MED-A (reviewer-claude) + LOW-1 (reviewer-codex)**: applySpawnGuards 下移到
    // 「所有 createSession 前的纯计算 + 可抛 DB 读」之后。
    // - MED-A: 旧实现 guard 先同步 inc fanOutSlot,但 release 只在下方 createSession 的 try/finally
    //   —— 中间 `leadRecord = sessionRepo.get()` 等裸 DB 读抛错(SQLITE_BUSY / I/O)会越过 handler
    //   永久泄漏 in-flight 计数(dec 仅 release 一条路径,byParent Map 进程级常驻)。下移后 guard 到
    //   createSession-try 之间无裸 DB 读,泄漏窗口归零。
    // - LOW-1: agentName body resolve 此时已在 guard 前,拼错 agentName 提前 return err 不再消耗
    //   app-wide spawn-rate token。

    // D1 (CHANGELOG_76): agentName 非空 → 按 plugin agents registry resolve body file，
    // 把 body 作为 prompt 前缀注入。getBundledAssetContent('agent', name, adapter) 已 startup
    // 时 loadBundledAssets 预热缓存（main/index.ts:202 step 8.5），现读 fs 一次性拿到。
    // 找不到（拼写错 / 没安装该 plugin）→ 直接 err 防止静默落空 fallback。
    //
    // Deepseek profile reuses Claude-side agents/skills/resources. It has no separate bundled
    // asset root, so agentName resolves through the claude-code plugin root.
    //
    // REVIEW_31 Bug 1+2 修法：getBundledAssetContent 真实签名是 discriminated union
    // `{ok:true,content:string} | {ok:false,reason:string}`，老代码把它当 `string|null`
    // 用，模板字符串 `${object}` toString 成 "[object Object]"，agent body 完全没注入；
    // 测试 mock 也错齐成 string|null 同样错型，单测 100% 通过 / 生产 100% 失败。这里
    // 必须正确解 union，并把 reason 透传给 err 便于 caller 排查。
    let promptToUse = args.prompt;
    // plan model-wiring-and-handoff-20260514 Step 3.1：agent body frontmatter `model` 提取。
    // reviewer-claude.md `model: opus` / reviewer-codex.md `model: sonnet` 现状零改动即生效；
    // 提取后通过 createSession({ model }) 透传给 SDK，让 reviewer teammate 真正按 frontmatter
    // 标的 model 跑（修前 model 字段死字段，详 plan Context 第 1 项）。
    let modelFromFrontmatter: string | undefined;
    if (args.agentName) {
      const assetAdapter =
        args.adapter === 'deepseek-claude-code' ? 'claude-code' : args.adapter;
      if (assetAdapter !== 'claude-code' && assetAdapter !== 'codex-cli') {
        return err(
          `agentName not supported for adapter "${args.adapter}"`,
          'Plugin agents are scanned from claude-config / codex-config plugin roots only. Adapters outside this list have no agent_deck plugin scope; drop agentName and pass full prompt directly.',
        );
      }
      const bodyResult = getBundledAssetContent('agent', args.agentName, assetAdapter);
      if (!bodyResult.ok) {
        return err(
          `agent body not found for agentName="${args.agentName}": ${bodyResult.reason}`,
          'Plugin agent registry does not include this name. Check Header → 📚 资产库 → Agents tab for available bundled agent names (e.g. "reviewer-claude" / "reviewer-codex"). Spawn aborted to avoid silently falling back to caller prompt without the agent body.',
        );
      }
      // 拼接：body 在前 + 1 行空行分隔 + caller prompt 在后（task body 部分）。
      // 与 SDK system prompt 注入路径不同 —— in-process / HTTP / stdio 都没法直接改 SDK
      // system prompt prefix（adapter API 没暴露 additionalSystemPrompt），所以在
      // user-message 头部注入是最简兼容方案。reviewer-* agent body 顶部已有 frontmatter，
      // body 本身就是给 reviewer 看的「角色提示」，作为 user message 头部仍能起到 priming 作用。
      promptToUse = `${bodyResult.content}\n\n---\n\n${args.prompt}`;

      // plan Step 3.1：parse frontmatter 拿 model（仅 type === 'string' 且非空白才认）。
      // bodyResult.content 含完整文件含 frontmatter block；parseFrontmatter 没 frontmatter
      // 时返回 {}，model 字段不存在时 fm.model = undefined → modelFromFrontmatter 仍 undefined。
      const fm = parseFrontmatter(bodyResult.content);
      if (typeof fm.model === 'string' && fm.model.trim().length > 0) {
        modelFromFrontmatter = fm.model.trim();
        // prompt-asset-review-optimize-20260527 跟进 reviewer-claude HIGH 修法:
        // 删除原 codex-cli adapter warn — codex-sdk v0.131.0 ThreadOptions.model
        // 已支持 per-thread override,frontmatter model 在 codex 端 runtime 真生效。
      }
    }

    // Spawn 权限 / 沙盒默认值：
    // - caller 显式传参永远最高优先级；
    // - caller 与 target adapter 相同才继承 lead 的 permission/sandbox；
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
    const effectivePermissionMode =
      args.permissionMode ??
      (shouldInheritAdapterSettings
        ? (leadRecord?.permissionMode ?? undefined)
        : defaultPermissionModeForTargetAdapter(args.adapter));
    const effectiveCodexSandbox =
      args.codexSandbox ??
      (shouldInheritAdapterSettings ? (leadRecord?.codexSandbox ?? undefined) : undefined);
    const effectiveClaudeCodeSandbox =
      args.claudeCodeSandbox ??
      (shouldInheritAdapterSettings ? (leadRecord?.claudeCodeSandbox ?? undefined) : undefined);

    // 完整防递归 3 条规则（ADR §6 / REVIEW_28 移除 §6.2 cwd cycle 后）：depth 上限 /
    // fan-out / spawn-rate（顺序：不消耗资源的检查前置，详 spawn-guards.ts 头注释）。
    // 任一 deny 立即返回；通过 → 拿到 fanOutSlot，必须在 createSession 完成后（无论成功
    // 失败）调 release()。
    // plan handoff-no-spawn-guards-20260526 §D4 / §D6:透传 opts.handOffMode,hand-off 路径
    // 完全跳过三道防御 + 不进 in-flight 计数(详 applySpawnGuards jsdoc + spawn-link-guard.ts)
    //
    // **REVIEW_85 MED-A (reviewer-claude) 位置不变量**:guard 必须在「上面所有可抛 DB 读
    // (leadRecord = sessionRepo.get) + agentName body resolve」之后、ensureByName 之前。
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
    let teamIdEarly: string | null = null;
    let teamCreatedNow = false;
    if (args.teamName) {
      try {
        const team = agentDeckTeamRepo.ensureByName(args.teamName, { source: 'mcp' });
        teamIdEarly = team.id;
        teamCreatedNow = agentDeckTeamRepo.listAllMembers(team.id).length === 0;
      } catch (e) {
        // ensure 失败时 lead context block + placeholder 都不注入；後續 addMember 也跳過。
        logger.warn(`[mcp spawn_session] team ensureByName failed for "${args.teamName}":`, e);
      }
    }

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
    // 注入条件：teamIdEarly 真 + callerExists 真（有 team 且 caller 在 sessions 表）；任一缺
    // 不注入（external caller / no-team spawn 没 reply chain anchor，注入也无意义）。
    // **DB messages.body 列存原始 promptToUse**（不含 prefix / lead context block），与 send_message
    // buildWireBody 同款（wire prefix 在内存里加，不写回 DB）。
    //
    // leadDisplayName fallback：优先取 leadRecord.title（用户 / cwd-basename 默认），缺失时用
    // `<leadAdapter>:<lead-sid 前 8>` 同 buildWireBody.resolveFromDisplayName 的 fallback 形态。
    // 严格说 buildWireBody 优先取 team_member.displayName，但 spawn 路径下 lead addMember 在
    // createSession 之后做（team_member sessionId FK 必须先存在），所以这里只能用 leadRecord.title。
    // teammate 看到的是 lead "first impression" 名字，与之后 send_message reply 看到的可能不同
    // —— 视觉上一致足以让用户识别"是同一个 lead"，无需强一致。
    const willInjectWirePrefix = !!teamIdEarly && callerExists;
    let placeholderId: string | null = null;
    let promptForSpawn = promptToUse; // 给 SDK 的 wire 形式
    if (willInjectWirePrefix && teamIdEarly) {
      const newPlaceholderId = crypto.randomUUID();
      placeholderId = newPlaceholderId;
      const leadAdapter = leadRecord?.agentId ?? 'unknown-adapter';
      // plan hand-off-session-adopt-teammates-20260520 Phase 4 (Round 4 NEW MED-B 修法 —
      // SSOT 唯一化):wire prefix + lead context block 装配抽到 buildLeadContextBlock helper
      // (lead-context-block.ts)。helper 仅给 spawn 路径用 — adopt 路径 (Phase 4c) 走独立
      // buildAdoptedTeamsContextBlock helper (adopted-teams-context-block.ts),不复用本
      // helper(详 lead-context-block.ts 顶部 jsdoc)。
      // 注:`willInjectWirePrefix && teamIdEarly` 等价 willInjectWirePrefix 单条件,加 explicit
      // teamIdEarly null check 让 TS narrow `string | null` → `string`(willInjectWirePrefix
      // 用 `!!teamIdEarly` 但 TS 不能跨变量 narrow)。
      const { wirePrefix, contextBlock } = buildLeadContextBlock({
        leadSessionId: caller.callerSessionId,
        teamId: teamIdEarly,
        leadDisplayName,
        leadAdapter,
        placeholderId: newPlaceholderId,
      });
      promptForSpawn = `${wirePrefix}${contextBlock}\n---\n\n${promptToUse}`;
    }

    // 实际 spawn
    // REVIEW_32 follow-up MED-1 (fan-out race) 修法：把 setSpawnLink 提到 try 块内 createSession
    // 之后，与 fanOutSlot.release()（finally）形成顺序保证。旧实现 release 在 finally 跑完才
    // setSpawnLink → applySpawnGuards 下次调用看到 inFlightChildren=0（已 release）+
    // listChildren=oldCount（新 sid 未 setSpawnLink）→ effective 比真实少 1，能突破 maxFanOut + 1。
    // 新版 setSpawnLink 在 release 之前做完，关闭 race window。
    let sid: string;
    try {
      // p4-d2-impl Step 2.1：用 buildCreateSessionOptions builder helper 按 args.adapter narrow
      // 到对应 union arm（filter 掉不属本 adapter 的字段，TS 编译期阻止字段误传）。原 inline
      // omitUndefined + spread+ternary 模式（Step 2.2）作为 raw 输入塞 builder。
      sid = await adapter.createSession(
        buildCreateSessionOptions(args.adapter, {
          cwd: args.cwd,
          prompt: promptForSpawn, // wire 形式（spawn 路径下若有 teamName 则含 [msg <id>] prefix）
          // 使用 effective 字段（caller 显式 > same-adapter lead 继承 > target adapter 默认）
          // REVIEW_37 P1-Phase2 (claude F4 LOW)：omitUndefined 收口 4 个简单 spread+ternary。
          // 仅 extraAllowWrite（length > 0 语义）+ model（falsy 语义）保留 inline ternary。
          ...omitUndefined({
            permissionMode: effectivePermissionMode,
            codexSandbox: effectiveCodexSandbox,
            claudeCodeSandbox: effectiveClaudeCodeSandbox,
            teamName: args.teamName,
            // plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + §D7（信号源）：透传
            // args.agentName → options-builder narrowToCodexOpts 按 reviewer-* 路径触发 codex
            // teammate spawn default spread（4 字段 unsafe default：codexSandbox /
            // approvalPolicy / networkAccessEnabled / additionalDirectories）。
            //
            // 仅 codex-cli adapter 消费；claude-code adapter narrow 时 filter 掉
            // （narrowToClaudeOpts 不引用 agentName 字段）。
            agentName: args.agentName,
            // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2: hand_off_session
            // handler 装配的 HandOffMetadata 透传给 builder → adapter narrow → bridge
            // createSession → first user message emit spread 进 events.payload。
            handOff: args.handOff,
          }),
          // REVIEW_36 R2 HIGH-B + MED-C：透传 extra writable roots（仅 caller 显式传时）—
          // 留 inline 因要 length > 0 检查（空数组也跳过，omitUndefined 不处理 empty array）
          ...(args.extraAllowWrite !== undefined && args.extraAllowWrite.length > 0
            ? { extraAllowWrite: args.extraAllowWrite }
            : {}),
          // plan model-wiring-and-handoff-20260514 Step 3.1 + prompt-asset-review-optimize-20260527 修订：
          // 透传 frontmatter `model` 给 createSession。两 adapter runtime 都真生效:
          // - claude-code → bridge.createSession → buildClaudeQueryOptions → SDK options.model 切 runtime model + setModel 持久化 resume 一致
          // - codex-cli (codex-sdk v0.131.0+) → bridge.createSession → ThreadOptions.model 透传 codex CLI runtime + setModel 持久化(原 D5 "runtime 不生效" 判断已过期)
          // 留 inline 因 falsy 语义（空字符串视作未设，omitUndefined 仅过滤 undefined）。
          ...(modelFromFrontmatter ? { model: modelFromFrontmatter } : {}),
        }),
      );
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
      if (callerExists && shouldWriteSpawnLink({ handOffMode: opts?.handOffMode })) {
        const newDepth = parentDepth + 1;
        sessionRepo.setSpawnLink(sid, caller.callerSessionId, newDepth);
      }
    } catch (e) {
      fanOutSlot.release();
      // CHANGELOG_100 R2 fix (codex MED-2): createSession 失败 → cleanup 本次新建的空 team
      // 防 active team 列表污染。再次 verify 空才删（防并发 caller 已抢先 addMember）。
      if (teamCreatedNow && teamIdEarly) {
        try {
          const remainingMembers = agentDeckTeamRepo.listAllMembers(teamIdEarly);
          if (remainingMembers.length === 0) {
            agentDeckTeamRepo.hardDelete(teamIdEarly);
          }
        } catch (cleanupErr) {
          logger.warn(
            `[mcp spawn_session] team cleanup after createSession failure failed for ${teamIdEarly}:`,
            cleanupErr,
          );
        }
      }
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

    // R3.E0 ADR §5.1 amend：teamName 触发 universal team backend 把 caller 加为 lead +
    // 把新 session 加为 teammate（不再写 sessions.teamName 列）。
    // CHANGELOG_100 D9: ensureByName 已提到 createSession 之前（teamIdEarly），这里只做 addMember。
    let teamId: string | null = teamIdEarly;
    if (args.teamName && teamIdEarly) {
      try {
        // caller 自动以 lead role 加入（如已 active 则保留）。caller 不在 sessions 表
        // （external __external__ 等）时跳过。
        // **[caller-scoped #2/4]** team addMember(grep anchor 详 L148-160 callerExists 定义)
        if (callerExists) {
          try {
            agentDeckTeamRepo.addMember({
              teamId: teamIdEarly,
              sessionId: caller.callerSessionId,
              role: 'lead',
              displayName: null,
            });
            // plan team-cohesion-fix-20260513 Phase A：lead addMember 后触发 session-upserted
            // 让桥点 enrich teams[] → renderer 立即看到 lead 的 🛡 chip（不再等下一个 agent event）。
            sessionManager.notifyTeamMembershipChanged(caller.callerSessionId);
            // REVIEW_35 MED-A7：emit `agent-deck-team-member-changed` 让 universal-message-watcher
            // dispatcher 收到 → fan-out member-joined adapter event 给同 team active member。
            // 修前 spawn / cli / ipc.adapters 三条路径只刷 UI 不通知 adapter chain。
            eventBus.emit('agent-deck-team-member-changed', {
              teamId: teamIdEarly,
              sessionId: caller.callerSessionId,
              kind: 'joined',
            });
          } catch (e) {
            if (!(e instanceof TeamInvariantError)) throw e;
            // **REVIEW_85 MED-1 (reviewer-codex)**: TeamInvariantError 不止表示「caller 已是
            // active member」(member-crud.ts:111),也表示 lead-count >= MAX_LEADS_PER_TEAM
            // (member-crud.ts:139) 以及 caller 已是 active teammate(非 lead)。旧实现一律吞当
            // 「已是 lead」幂等成功 → caller 实际没真加进 team 当 lead → 与新 session 无 shared
            // active team → teammate 首轮 send_message 撞 no-shared-team。
            // 修法:吞之前反查 caller 是否真的已是该 team 的 active lead;不是(lead-count 超 /
            // 已是 teammate)则 re-throw 让外层 catch(MED-2 修法)走降级 + 孤儿 team cleanup。
            const callerMembership = agentDeckTeamRepo.findActiveMembershipIn(
              teamIdEarly,
              caller.callerSessionId,
            );
            if (callerMembership?.role !== 'lead') throw e;
          }
        }
        agentDeckTeamRepo.addMember({
          teamId: teamIdEarly,
          sessionId: sid,
          // REVIEW_37 R2 HIGH-1 修法（双方一致 ✅ 真 HIGH，异构强冗余验证）：默认 'teammate'，
          // 但 baton 路径（hand_off_session 传 batonRole='lead'）让新 session 接管 lead 角色。
          // 修前：hand_off_session(teamName=X) 后 caller archive 触发 archiveTeamsIfOrphaned
          // → countActiveLeads=0 → team auto-archive → 残留 reviewer + 新 session 失去 active
          // shared team → send_message 走 no-shared-team reject。修后：新 session 是 lead →
          // archive caller 后 countActiveLeads=1 不触发 auto-archive → 残留 reviewer 通过新
          // session 仍可继续协作。
          //
          // 普通 spawn_session（caller 是 lead，新 session 通常是 teammate）行为不变 — opts.batonRole
          // 仅在 hand-off-session baton 路径显式传入；其他 caller（spawn-via-tool / 测试）走默认 'teammate'。
          role: opts?.batonRole ?? 'teammate',
          // REVIEW_31 Bug 4：teammate displayName 同步写 team_member 表，
          // 让 wire format buildWireBody 优先取此名字（不再 fallback 到 `<adapter>:<sid_8>`）。
          displayName: teammateDisplayName,
        });
        // plan team-cohesion-fix-20260513 Phase A Step A7：teammate addMember 后同样触发 session-upserted
        // 让桥点 enrich teams[]（与 lead 路径对称）。
        sessionManager.notifyTeamMembershipChanged(sid);
        // REVIEW_35 MED-A7：同 lead 路径补 emit 让 dispatcher 看到 teammate 加入。
        eventBus.emit('agent-deck-team-member-changed', {
          teamId: teamIdEarly,
          sessionId: sid,
          kind: 'joined',
        });
        // plan team-cohesion-fix-20260513 Phase A Step A8：删 sessionManager.recordCreatedTeamName 调用
        // —— universal team backend addMember 已是 SSOT，不再写老 sessions.teamName 列；
        // v012 migration 后此列彻底 drop。
      } catch (e) {
        // **REVIEW_85 MED-2 (reviewer-codex)**: 旧实现仅 logger.warn 吞掉 addMember(lead/teammate
        // 任一)失败,但 teamId 仍保留 → 下方 placeholder 照插 → 末尾 return ok 带 teamId。caller
        // 收到「team 创建成功」假象,但实际 caller 与新 session 不共享 active team(membership 没写
        // 成),teammate 按 prompt 调 send_message 首轮撞 no-shared-team / replyToMessageId not found。
        // 修法:team setup 失败 = 整个 team-spawn 失败 → close 已起的孤儿 session + cleanup 本次
        // 新建空 team(mirror createSession-catch L325 re-verify-empty 防并发抢先)+ return err
        // 让 caller 知道失败可干净 retry,不返回半残 ok。
        logger.warn(`[mcp spawn_session] addMember failed for "${args.teamName}":`, e);
        try {
          await sessionManager.close(sid);
        } catch (closeErr) {
          logger.warn(
            `[mcp spawn_session] orphan session close after addMember failure failed for ${sid}:`,
            closeErr,
          );
        }
        if (teamCreatedNow && teamIdEarly) {
          try {
            if (agentDeckTeamRepo.listAllMembers(teamIdEarly).length === 0) {
              agentDeckTeamRepo.hardDelete(teamIdEarly);
            }
          } catch (cleanupErr) {
            logger.warn(
              `[mcp spawn_session] team cleanup after addMember failure failed for ${teamIdEarly}:`,
              cleanupErr,
            );
          }
        }
        return err(
          `team setup failed for "${args.teamName}": ${e instanceof Error ? e.message : String(e)}`,
          'Session was spawned but team membership could not be established (e.g. lead count limit reached, or a DB write error). The orphan session was closed and any empty team created in this call was removed. Fix the team condition and retry spawn_session, or spawn without teamName for a standalone session.',
        );
      }
    }

    // plan team-cohesion-fix-20260513 Phase B5：spawn 路径与 send_message 贯通的方案 A 实现 ——
    // spawn 仍把 prompt 给 adapter（SDK streaming 协议要求 first user message），同时在
    // messages 表 enqueue 一条 placeholder message（body=promptToUse, status='delivered'，
    // 不重复投递）作为 lead/teammate 对话链的锚点。lead 不再主动 poll reply（CHANGELOG_100 删旧 tool）；
    // teammate first turn 完成后调 send_message({replyToMessageId: spawnPromptMessageId, ...})
    // 回复，reply 自动 dispatch 进 lead conversation（J fix 删，CHANGELOG_100）。
    // 无 team / no-shared-team 时不入队 placeholder（spawn 没有可关联的对话场景）。
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
        logger.warn(`[mcp spawn_session] placeholder message enqueue failed:`, e);
      }
    }

    const created = sessionRepo.get(sid);
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
      spawnDepth: created?.spawnDepth ?? (callerExists && shouldWriteSpawnLink({ handOffMode: opts?.handOffMode }) ? parentDepth + 1 : 0),
      sentAt: Date.now(),
      // plan team-cohesion-fix-20260513 Phase B5：lead 用此 messageId 作为 teammate first reply anchor
      spawnPromptMessageId,
    } satisfies SpawnSessionResult);
  },
);
