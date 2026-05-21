/**
 * adopted-teams-context-block.ts —— hand_off_session adopt_teammates: true 路径专用的
 * cold-start prompt prepend block 装配 helper(plan hand-off-session-adopt-teammates-20260520
 * Phase 4 D11 v8 + Round 6 codex MED-1 + Round 7 codex MED-2 修法)。
 *
 * **抽出动机**(plan §决策对抗 Round 6 codex MED-1 deep design hole):
 * adopt 路径下 caller 已 archive(default baton)+ newSid 成为新 lead → caller 与 newSid
 * 无 shared active team → 新 session 按 spawn 路径 buildLeadContextBlock 装配的 wire
 * prefix + "回 lead 用 send_message" 指令必撞 send.ts:52-61 no-shared-team(三处实证 send.ts +
 * member-query.ts:141-159 findSharedActiveTeams + manager.ts:331-340 archive)。
 *
 * **adopt 路径独立装配**(Round 7 codex MED-2 同步 v7 D11 单一语义):
 * - **不复用** spawn 的 buildLeadContextBlock(spawn 派出小弟语义,含"回 lead"指令 — adopt
 *   单向交接 + caller 退出语义不适用)
 * - **不含** wire prefix `[from ...][msg ...][sid ...]`(adopt 路径 caller 退出无人接 reply,
 *   wire prefix 锚点无意义)
 * - **不含** placeholderId(adopt 路径不写 placeholder message — 详 hand-off-session.ts handler
 *   adopt 分支)
 * - 仅告诉新 session "你是新 lead,接管这些 team,这些 teammate"
 *
 * **设计语义对比**:
 * - **spawn = 派出小弟**:lead 留在 conversation,teammate 起来后 reply 回 lead 用 wire
 *   prefix `[msg <id>]` 锚点 + send_message → lead 收到 reply auto-injected
 * - **adopt = baton 单向交接**:lead 退出(archive),新 session 接管成为新 lead,与 caller
 *   无 reply chain(caller 已 exit);新 session 自己用 send_message 给保留的 teammate 发新
 *   消息,teammate first reply 自动含 wire prefix `[from <name> @ <adapter>][msg <id>][sid <sid>]` 让新
 *   session 用 reply_to_message_id 维持 reply chain
 *
 * **Round 7 codex MED-1 修法**(v7 → v8):删 newLeadSid 字段 — 现有 spawn/adapter contract
 * 一次性传 promptForSpawn 不允许 spawn 后 mutate first turn prompt(spawn.ts:250-253 +
 * claude adapter sdk-bridge/index.ts:211-215 + codex adapter sdk-bridge/index.ts:451-456 实证)。
 * SDK 自身 sid 已知,prompt 用 "You (the new SDK session)" 即可,不需 prompt 字面重复 newSid。
 *
 * **Round 7 codex LOW 修法**(partial adopt warning):非 primary team 的 swapLead 可能失败
 * (Phase 6 D5 partial adopt 接受语义 — firstTeam fatal abort 但其他 team 失败仍 ok return)。
 * prompt 内 multi-team 节标 "**attempted** to adopt as lead" 而非 "已 adopted",并加
 * "verify shared team membership via list_sessions before messaging — partial adopt may have
 * failed for some teams" warning,让新 session 先验证 shared membership 再 send_message。
 */

export interface AdoptedTeam {
  /** team id(`agent_deck_teams.id`) */
  id: string;
  /** team display name */
  name: string;
  /**
   * 该 team 的 teammate sid 列表(过滤 caller 自己 + leftAt!==null 软退出后剩余 active sids)。
   * 空数组合法(team 内仅 caller 一个 lead,无 teammate)— prompt 内显示 `(none)`。
   */
  teammateSids: string[];
}

export interface BuildAdoptedTeamsContextBlockOpts {
  /**
   * Primary team(callerLeadMemberships[0])— 永远存在,N5 ≥1 lead 硬约束已在 handler
   * spawn 之前 fail-fast 短路 caller 无任何 lead team 场景;调本 helper 时 callerLeadMemberships.length >= 1。
   */
  firstTeam: AdoptedTeam;
  /**
   * 其余 lead-role active team(callerLeadMemberships.slice(1))— 多 team caller 才有值。
   * 单 team caller 时空数组,prompt 不输出 multi-team 节(`Multi-team — other teams attempted...`)。
   */
  otherLeadTeams: AdoptedTeam[];
}

/**
 * adopt 路径装配 cold-start prompt prepend block。caller(hand-off-session.ts handler)在
 * spawn 之前调用,把 `<adoptedBlock>\n---\n\n<resolvedColdStartPrompt>` 拼成 spawn args.prompt
 * 喂 SDK first message。**不**写 placeholder message(adopt 路径无 reply chain anchor 需求)。
 *
 * **prompt 结构**(v8 final design):
 *
 * ```text
 * ## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)
 *
 * You (the new SDK session) just became lead of N team(s) via hand_off_session adopt path.
 * The previous caller has handed off this baton and exited — you should not try to reply to them.
 *
 * ### Primary team — `<first-team-name>` (id: `<first-team-id>`)
 * Teammate sids: `<sid-1>`, `<sid-2>`
 *
 * ### Multi-team — other teams **attempted** to adopt as lead   ← 仅 multi-team(N>1)时出现
 * (verify shared team membership via `list_sessions` before messaging — partial adopt may have failed for some teams)
 * - Team `<team-name-2>` (id: `<team-id-2>`): teammate sids `<sid-3>`, `<sid-4>`
 *
 * ### How to communicate with teammates
 * Use `send_message({ session_id: <teammate-sid>, team_id: <team-id>, text: ... })` — for first-turn message omit `reply_to_message_id`.
 * Teammates' first reply will auto-include wire prefix `[from <name> @ <adapter>][msg <id>][sid <sid>]` — use `reply_to_message_id` from that prefix on subsequent send_message to maintain reply chain.
 * ```
 *
 * **不含** wire prefix / placeholderId / "回 lead" 指令(spawn 派小弟语义),与 adopt 单向交接
 * 语义匹配。
 */
export function buildAdoptedTeamsContextBlock(
  opts: BuildAdoptedTeamsContextBlockOpts,
): string {
  const totalTeams = 1 + opts.otherLeadTeams.length;
  const formatTeammateSids = (sids: string[]): string =>
    sids.length === 0 ? '(none)' : sids.map((s) => `\`${s}\``).join(', ');

  const lines: string[] = [
    `## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)`,
    ``,
    `You (the new SDK session) just became lead of ${totalTeams} team${totalTeams > 1 ? 's' : ''} via hand_off_session adopt path.`,
    `The previous caller has handed off this baton and exited — you should not try to reply to them.`,
    ``,
    `### Primary team — \`${opts.firstTeam.name}\` (id: \`${opts.firstTeam.id}\`)`,
    `Teammate sids: ${formatTeammateSids(opts.firstTeam.teammateSids)}`,
  ];

  if (opts.otherLeadTeams.length > 0) {
    // v8 Round 7 codex LOW 修法:partial adopt 时非 primary team 的 swapLead 可能失败,
    // prompt 标 "Attempted" 不写"已 adopted" + verify warning。
    lines.push(
      ``,
      `### Multi-team — other teams **attempted** to adopt as lead`,
      `(verify shared team membership via \`list_sessions\` before messaging — partial adopt may have failed for some teams)`,
    );
    for (const t of opts.otherLeadTeams) {
      lines.push(
        `- Team \`${t.name}\` (id: \`${t.id}\`): teammate sids ${formatTeammateSids(t.teammateSids)}`,
      );
    }
  }

  lines.push(
    ``,
    `### How to communicate with teammates`,
    `Use \`send_message({ session_id: <teammate-sid>, team_id: <team-id>, text: ... })\` — for first-turn message omit \`reply_to_message_id\`.`,
    `Teammates' first reply will auto-include wire prefix \`[from <name> @ <adapter>][msg <id>][sid <sid>]\` — use \`reply_to_message_id\` from that prefix on subsequent send_message to maintain reply chain.`,
    ``,
  );

  return lines.join('\n');
}
