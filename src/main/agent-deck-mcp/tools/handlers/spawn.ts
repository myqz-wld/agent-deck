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
import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import { eventBus } from '@main/event-bus';
import { getBundledAssetContent } from '@main/bundled-assets';
import { parseFrontmatter } from '@main/utils/frontmatter';
import { omitUndefined } from '@main/utils/optional-fields';
import { sanitizeWireFieldName } from '@shared/wire-prefix';

import { applySpawnGuards } from '../../spawn-guards';
import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { SpawnSessionArgs, SpawnSessionResult } from '../schemas';

export const spawnSessionHandler = withMcpGuard(
  'spawn_session',
  async (
    args: SpawnSessionArgs,
    ctx: HandlerContext,
    opts?: { batonMode?: boolean; batonRole?: 'lead' | 'teammate' },
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
    // plan model-wiring-and-handoff-20260514 Step 3.1：agent body frontmatter `model` 提取。
    // reviewer-claude.md `model: opus` / reviewer-codex.md `model: sonnet` 现状零改动即生效；
    // 提取后通过 createSession({ model }) 透传给 SDK，让 reviewer teammate 真正按 frontmatter
    // 标的 model 跑（修前 model 字段死字段，详 plan Context 第 1 项）。
    let modelFromFrontmatter: string | undefined;
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

      // plan Step 3.1：parse frontmatter 拿 model（仅 type === 'string' 且非空白才认）。
      // bodyResult.content 含完整文件含 frontmatter block；parseFrontmatter 没 frontmatter
      // 时返回 {}，model 字段不存在时 fm.model = undefined → modelFromFrontmatter 仍 undefined。
      const fm = parseFrontmatter(bodyResult.content);
      if (typeof fm.model === 'string' && fm.model.trim().length > 0) {
        modelFromFrontmatter = fm.model.trim();
        // plan Step 3.2 / D5：codex-cli adapter SDK startThread 不接受 per-thread model
        // override（runtime model 由 ~/.codex/config.toml 决定）—— 配 frontmatter model
        // 仅持久化 + UI 显示，不会真正切 model。warn 一次让维护者知道（spawn 不阻断）。
        if (args.adapter === 'codex-cli') {
          console.warn(
            `[mcp spawn_session] agent_name="${args.agent_name}" frontmatter model="${modelFromFrontmatter}"` +
              ` 对 codex-cli adapter 仅持久化未生效：codex SDK 不接受 per-thread model override，` +
              `runtime model 由 ~/.codex/config.toml 顶层 \`model\` 字段决定。`,
          );
        }
      }
    }

    // REVIEW_32 HIGH-5：spawn 默认继承 lead session 的 permission_mode / codex_sandbox /
    // claude_code_sandbox。caller 显式传则覆盖；external caller (callerExists==false) 不继承
    // 沿用 adapter 默认（避免外部 MCP client 误触发 lead 沙盒透传）。
    // 解决 reviewer-codex 报「外层 Claude Code sandbox 拦了 codex in-process app-server 初始化」
    // 的根因 —— spawn 出的 reviewer-codex teammate 没继承 lead 的 sandbox 设置，跑在受限沙盒里。
    // REVIEW_36 LOW-1：sessionRepo.get 单次反查（旧实现 callerExists / leadRecord 各调一次）。
    const leadRecord = sessionRepo.get(caller.callerSessionId);
    const callerExists = leadRecord !== null;
    const effectivePermissionMode =
      args.permission_mode ?? leadRecord?.permissionMode ?? undefined;
    const effectiveCodexSandbox = args.codex_sandbox ?? leadRecord?.codexSandbox ?? undefined;
    const effectiveClaudeCodeSandbox =
      args.claude_code_sandbox ?? leadRecord?.claudeCodeSandbox ?? undefined;

    // CHANGELOG_100 / plan mcp-tool-simplify-20260514 D9：把 team ensure 提到 createSession 前，
    // 这样 wire prefix + lead context block 注入 prompt 时能用真实 teamId（删 reply_message
    // 后 teammate 必须知道 lead session_id + team_id 才能 send_message 回 lead）。
    // ensureByName 幂等：已存在 team 直接返回；后续 addMember 调用仍需 sid，留在 createSession
    // 之后做（team_member 表 sessionId FK 必须先存在）。
    //
    // CHANGELOG_100 R2 fix (codex MED-2): ensureByName 提前后 createSession 失败 catch 路径必须
    // cleanup 本次新建的空 team，否则 active team 列表会污染（无 lead / 无 teammate 的孤儿 team）。
    // teamCreatedNow 判定：listAllMembers(team.id).length === 0 表示 ensureByName 刚 INSERT
    // (existing active team 必有 ≥ 1 lead member)。catch 时再次 verify 防并发抢先 addMember。
    let teamIdEarly: string | null = null;
    let teamCreatedNow = false;
    if (args.team_name) {
      try {
        const team = agentDeckTeamRepo.ensureByName(args.team_name, { source: 'mcp' });
        teamIdEarly = team.id;
        teamCreatedNow = agentDeckTeamRepo.listAllMembers(team.id).length === 0;
      } catch (e) {
        // ensure 失败时 lead context block + placeholder 都不注入；後續 addMember 也跳過。
        console.warn(`[mcp spawn_session] team ensureByName failed for "${args.team_name}":`, e);
      }
    }

    // REVIEW_31 Bug 4：teammate display name fallback 链 = args.display_name > args.agent_name > 不动。
    // teammateDisplayName 在多处被引用（wire prefix injection / setTitle / addMember / ok return），
    // 提前算供下面 lead context block 注入也能引用 lead displayName 对称信息。
    const teammateDisplayName = args.display_name ?? args.agent_name ?? null;
    const leadDisplayName = leadRecord?.title ?? null;

    // plan team-cohesion-fix-20260513 Phase B7 / CHANGELOG_100 D9 升级：spawn 路径
    // wire format 与 buildWireBody 同款 `[from <name> @ <adapter>][msg <id>][sid <senderSid>]`
    // 三段，让 teammate 端 message-row.tsx parseWirePrefix 能识别这条 prompt 也是 cross-session
    // message（带 ↩ chip + lead context block 折叠 disclosure），不被当成"自己输入的 user message"渲染。
    //
    // teammate 收到 prompt 后从顶部 regex `\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]` 提
    // messageId + senderSessionId 双锚点，调
    // send_message({reply_to_message_id: msgId, session_id: senderSid, team_id, text}) 回复 lead。
    // lead context block 显式列出 lead session_id / team_id / lead displayName + send_message 用法，
    // 让 teammate 不必依赖 wire prefix 解析也能 send_message（双层冗余防 prompt 长度截断 / 协议漂移）。
    //
    // 注入条件：teamIdEarly 真 + callerExists 真（有 team 且 caller 在 sessions 表）；任一缺
    // 不注入（external caller / no-team spawn 没 reply chain anchor，注入也无意义）。
    // **DB messages.body 列存原始 promptToUse**（不含 prefix / lead context block），与 send_message
    // buildWireBody 同款（wire prefix 在内存里加，不写回 DB）。
    //
    // leadDisplayName fallback：优先取 leadRecord.title（用户 / cwd-basename 默认），缺失时用
    // `<leadAdapter>:<lead-sid 前 8>` 同 buildWireBody.resolveFromDisplayName 的 fallback 形态。
    // 严格说 buildWireBody 优先取 team_member.display_name，但 spawn 路径下 lead addMember 在
    // createSession 之后做（team_member sessionId FK 必须先存在），所以这里只能用 leadRecord.title。
    // teammate 看到的是 lead "first impression" 名字，与之后 send_message reply 看到的可能不同
    // —— 视觉上一致足以让用户识别"是同一个 lead"，无需强一致。
    const willInjectWirePrefix = !!teamIdEarly && callerExists;
    let placeholderId: string | null = null;
    let promptForSpawn = promptToUse; // 给 SDK 的 wire 形式
    if (willInjectWirePrefix) {
      placeholderId = crypto.randomUUID();
      const leadAdapter = leadRecord?.agentId ?? 'unknown-adapter';
      // CHANGELOG_100 R2 fix (codex MED-1): sanitizeWireFieldName 处理 `]` / `\n` / `[`，
      // 避免 user 设的 session.title (e.g. "feat: [test]") 破坏 wire prefix 解析。
      // 同款 sanitize 在 buildWireBody (universal-message-watcher.ts) 也做了。
      const leadFromName = sanitizeWireFieldName(
        leadDisplayName ?? `${leadAdapter}:${caller.callerSessionId.slice(0, 8)}`,
      );
      const leadAdapterSanitized = sanitizeWireFieldName(leadAdapter);
      const leadContextBlock =
        `## Hand-off context (auto-injected by Agent Deck MCP)\n` +
        `- Lead session_id: \`${caller.callerSessionId}\`\n` +
        `- Team id: \`${teamIdEarly}\`\n` +
        `- Lead displayName: ${leadDisplayName ?? '(unset)'}\n` +
        `\n` +
        `回 lead 用：\n` +
        `\`\`\`\n` +
        `mcp__agent-deck__send_message({\n` +
        `  session_id: '${caller.callerSessionId}',  // lead session_id\n` +
        `  team_id: '${teamIdEarly}',  // 当前 team id\n` +
        `  text: '<reply text>',\n` +
        `  reply_to_message_id: '<msg-id from wire prefix>'  // 从顶部 [msg <id>] 提取\n` +
        `})\n` +
        `\`\`\`\n` +
        `wire prefix regex（双锚点）: \`/\\[msg ([0-9a-f-]+)\\]\\[sid ([0-9a-f-]+)\\]/\`\n`;
      promptForSpawn =
        `[from ${leadFromName} @ ${leadAdapterSanitized}][msg ${placeholderId}][sid ${caller.callerSessionId}]\n` +
        `${leadContextBlock}\n---\n\n${promptToUse}`;
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
          prompt: promptForSpawn, // wire 形式（spawn 路径下若有 team_name 则含 [msg <id>] prefix）
          // REVIEW_32 HIGH-5：使用 effective 字段（caller 显式 > lead 继承 > undefined）
          // REVIEW_37 P1-Phase2 (claude F4 LOW)：omitUndefined 收口 4 个简单 spread+ternary。
          // 仅 extra_allow_write（length > 0 语义）+ model（falsy 语义）保留 inline ternary。
          ...omitUndefined({
            permissionMode: effectivePermissionMode,
            codexSandbox: effectiveCodexSandbox,
            claudeCodeSandbox: effectiveClaudeCodeSandbox,
            teamName: args.team_name,
          }),
          // REVIEW_36 R2 HIGH-B + MED-C：透传 extra writable roots（仅 caller 显式传时）—
          // 留 inline 因要 length > 0 检查（空数组也跳过，omitUndefined 不处理 empty array）
          ...(args.extra_allow_write !== undefined && args.extra_allow_write.length > 0
            ? { extraAllowWrite: args.extra_allow_write }
            : {}),
          // plan model-wiring-and-handoff-20260514 Step 3.1：透传 frontmatter `model` 给 createSession。
          // claude-code adapter → bridge.createSession → buildClaudeQueryOptions → SDK options.model
          // （runtime 切 model）+ setModel 持久化 resume 一致。
          // codex-cli adapter → bridge 仅 setModel 持久化 + warn（D5：runtime 不生效）。
          // 留 inline 因 falsy 语义（空字符串视作未设，omitUndefined 仅过滤 undefined）。
          ...(modelFromFrontmatter ? { model: modelFromFrontmatter } : {}),
        }),
      );
      // 仅当 caller 自身在 sessions 表里时记 spawn link（in-process 闭包外 caller 视为顶层）。
      // setSpawnLink 在 release 之前完成，关闭 fan-out race window（详上方 MED-1 注释）。
      //
      // **REVIEW_39 方案 1（双对抗 R1+R1.5 反驳轮共识，hand-off-mcp-teammate-bug-20260515）**：
      // batonMode=true 路径**不写 spawn-link**(spawnedBy=null + spawnDepth=0 默认值)。
      //
      // 修前 bug：hand_off_session 不传 team_name 时 setSpawnLink 仍写新 session.spawnedBy=
      // callerSid,SessionList Phase C(CHANGELOG_77)按 spawnedBy 树形分组渲染 ↳ teammate badge。
      // 真实窗口来自 spawn 后续 child upsert(典型 recordCreatedPermissionMode → manager
      // notifyTeamMembershipChanged emit session-upserted)早于 runBatonCleanup archive caller
      // 完成 — 即使 archive 100% 成功也触发(异步 await 几十-几百 ms),不依赖 archive 失败子集。
      //
      // 修法理由(R1+R1.5 反驳轮 codex 最终立场,claude grep 验证 7 处 spawned_by_filter 全
      // reviewer 派活路径无 production 消费方,无副作用):baton 是 caller 单向交出 + 新 session
      // 独立接手(hand-off-session.ts:21-39 jsdoc 设计意图明文「不是派出小弟干活」),不是 spawn
      // parent-child 关系。数据层不应记录 spawn-link 假装是 spawn 派遣关系。
      //
      // 历史 CHANGELOG_98 batonMode lateral spawnDepth 写入意图是给 spawn-guards 跳 depth check
      // 用,**不是** UI 区分 baton vs spawn 显示;方案 5(改 SessionList 用 spawnDepth 区分)是用
      // depth 字段编码 type 的 ad-hoc encoding(若未来真需要 baton chain audit,应引入显式
      // `spawn_link_kind: 'spawn' | 'baton'` 枚举字段或独立 baton-link 表)。
      //
      // 副作用范围(已逐一验证无影响):
      // - LineageSection.tsx 仅画 active team members(leftAt === null);baton default 不传
      //   team_name → 新 session 不入 team → LineageSection 不渲染 → 无影响
      // - list_sessions(spawned_by_filter) 救火针对 reviewer 派活路径,不针对 baton 路径
      //   (baton 后 caller 已 archive 退出,无人捡 baton child)
      // - PendingTab 用 session.teams[] 不用 spawnedBy → 无影响
      // - SessionDetail / TeamDetail 不引用 spawnedBy → 无影响
      // - spawn-guards.ts depth check 用 callerSession.spawnDepth 不用新 session.spawnDepth
      //   → 无影响
      if (callerExists && !opts?.batonMode) {
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
          console.warn(
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
    if (adapter.capabilities.canSetPermissionMode && effectivePermissionMode) {
      sessionManager.recordCreatedPermissionMode(sid, effectivePermissionMode);
    }

    // REVIEW_31 Bug 4：teammate display name fallback 链 = args.display_name > args.agent_name > 不动。
    // 只有 caller 显式给了一个有意义的名字（display_name / agent_name）才覆盖默认 cwd-basename
    // title —— 否则保留默认行为（avoid 把 agent_name 也强加给那些 caller 没传 agent_name 的「裸 spawn」场景）。
    // teamRepo.addMember 同步把 displayName 写进 team_member 表，wire format buildWireBody 优先取此字段
    // → wire prefix 从 fallback `claude-code:8023f956` 升级为「reviewer-claude」/「reviewer-codex」。
    // CHANGELOG_100 D9: teammateDisplayName 在前面已算（spawn 前注入 lead context block 也用到）；
    // 这里只负责 setTitle 副作用。
    if (teammateDisplayName) {
      try {
        sessionRepo.setTitle(sid, teammateDisplayName);
      } catch (e) {
        // 写 title 失败不阻塞 spawn 成功（最坏 fallback 默认 cwd-basename）
        console.warn(`[mcp spawn_session] setTitle(${sid}, ${teammateDisplayName}) failed:`, e);
      }
    }

    // R3.E0 ADR §5.1 amend：team_name 触发 universal team backend 把 caller 加为 lead +
    // 把新 session 加为 teammate（不再写 sessions.team_name 列）。
    // CHANGELOG_100 D9: ensureByName 已提到 createSession 之前（teamIdEarly），这里只做 addMember。
    let teamId: string | null = teamIdEarly;
    if (args.team_name && teamIdEarly) {
      try {
        // caller 自动以 lead role 加入（如已 active 则保留）。caller 不在 sessions 表
        // （external __external__ 等）时跳过。
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
            // 已 active 时 invariant 抛错；视为「已是 lead」幂等成功
            if (!(e instanceof TeamInvariantError)) throw e;
          }
        }
        agentDeckTeamRepo.addMember({
          teamId: teamIdEarly,
          sessionId: sid,
          // REVIEW_37 R2 HIGH-1 修法（双方一致 ✅ 真 HIGH，异构强冗余验证）：默认 'teammate'，
          // 但 baton 路径（hand_off_session 传 batonRole='lead'）让新 session 接管 lead 角色。
          // 修前：hand_off_session(team_name=X) 后 caller archive 触发 archiveTeamsIfOrphaned
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
        // —— universal team backend addMember 已是 SSOT，不再写老 sessions.team_name 列；
        // v012 migration 后此列彻底 drop。
      } catch (e) {
        console.warn(`[mcp spawn_session] addMember failed for "${args.team_name}":`, e);
      }
    }

    // plan team-cohesion-fix-20260513 Phase B5：spawn 路径与 send_message 贯通的方案 A 实现 ——
    // spawn 仍把 prompt 给 adapter（SDK streaming 协议要求 first user message），同时在
    // messages 表 enqueue 一条 placeholder message（body=promptToUse, status='delivered'，
    // 不重复投递）作为 lead/teammate 对话链的锚点。lead 不再主动 wait_reply（CHANGELOG_100 删 tool）；
    // teammate first turn 完成后调 send_message({reply_to_message_id: spawnPromptMessageId, ...})
    // 回复，reply 自动 dispatch 进 lead conversation（J fix 删，CHANGELOG_100）。
    // 无 team / no-shared-team 时不入队 placeholder（spawn 没有可关联的对话场景）。
    // Phase B7：用上面预生成的 placeholderId（与 promptForSpawn 里的 [msg <id>] 一致），
    // body 仍存原始 promptToUse（不含 wire prefix）。
    //
    // 已知 follow-up（REVIEW_32 §Follow-up MED-2）：placeholder enqueue 失败时只 console.warn
    // 但 prompt 已含 [msg <id>] prefix 发出去，teammate 按规约 send_message → original
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
      spawnDepth: created?.spawnDepth ?? (callerExists && !opts?.batonMode ? parentDepth + 1 : 0),
      sentAt: Date.now(),
      // plan team-cohesion-fix-20260513 Phase B5：lead 用此 messageId 调 wait_reply 等 teammate first reply
      spawnPromptMessageId,
    } satisfies SpawnSessionResult);
  },
);
