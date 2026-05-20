/**
 * adopted-teams-context-block.ts 单测(plan hand-off-session-adopt-teammates-20260520 Phase 4
 * step 1e — Round 8 codex LOW 文档清理 + claude INFO 模块位置)。
 *
 * **防漂移机制**:
 * - 本文件 input → output snapshot 测试(单 team / multi-team / empty teammate / partial adopt
 *   warning 各 case)
 * - hand-off-session.ts handler 测试(Phase 4d T4.4 / T4.5 / T6.X4)用 substring 验证 prompt
 *   含 helper 输出关键字串
 *
 * **核心契约**(plan §D11 v8 + Round 6/7 修法):
 * - **不**含 wire prefix `[from ...][msg ...][sid ...]`(adopt 路径 caller 退出无人接 reply)
 * - **不**含 placeholderId(adopt 路径不写 placeholder message)
 * - **不**含"回 lead 用 send_message"指令(spawn 派出小弟语义不适用)
 * - multi-team 节标 "**attempted** to adopt as lead" 而非"已 adopted"(partial adopt 接受语义)
 * - 含 "verify shared team membership via list_sessions" warning
 */

import { describe, it, expect } from 'vitest';
import { buildAdoptedTeamsContextBlock } from '../tools/handlers/adopted-teams-context-block';

describe('buildAdoptedTeamsContextBlock — adopt 路径 cold-start prompt prepend block 装配', () => {
  it('single-team caller: 仅 Primary team 节 + 不输出 Multi-team 节', () => {
    const result = buildAdoptedTeamsContextBlock({
      firstTeam: {
        id: 'team-primary',
        name: 'review-team',
        teammateSids: ['sid-A', 'sid-B'],
      },
      otherLeadTeams: [],
    });

    // 必含:Primary team 节
    expect(result).toContain("## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)");
    expect(result).toContain('You (the new SDK session) just became lead of 1 team via hand_off_session adopt path.');
    expect(result).toContain('handed off this baton and exited — you should not try to reply to them.');
    expect(result).toContain('### Primary team — `review-team` (id: `team-primary`)');
    expect(result).toContain('Teammate sids: `sid-A`, `sid-B`');
    expect(result).toContain('### How to communicate with teammates');

    // 关键不含:wire prefix / spawn-style "Hand-off context" / "回 lead" 指令
    expect(result).not.toMatch(/^\[from /);
    expect(result).not.toContain('## Hand-off context (auto-injected by Agent Deck MCP)'); // spawn 路径文案
    expect(result).not.toContain('回 lead 用'); // spawn 路径指令
    // adopt prompt How to communicate 节会含 reply_to_message_id 字串(教新 session 怎么用),
    // 但不含 spawn 路径式"回 lead"指令 — 上面 `回 lead 用` 已守门。这里关注的是不是教新 session
    // 反向给 caller 发 send_message(adopt 路径 caller 已 archive 走不通)。

    // 单 team caller 不输出 multi-team 节 + 不出现 "attempted" / verify warning
    expect(result).not.toContain('**attempted** to adopt as lead');
    expect(result).not.toContain('verify shared team membership');
  });

  it('multi-team caller (N=3): Primary + Multi-team 节 + attempted warning', () => {
    const result = buildAdoptedTeamsContextBlock({
      firstTeam: {
        id: 'team-primary',
        name: 'primary-team',
        teammateSids: ['sid-A'],
      },
      otherLeadTeams: [
        { id: 'team-2', name: 'team-two', teammateSids: ['sid-X', 'sid-Y'] },
        { id: 'team-3', name: 'team-three', teammateSids: ['sid-Z'] },
      ],
    });

    // 总 team 数 N=3
    expect(result).toContain('You (the new SDK session) just became lead of 3 teams via hand_off_session adopt path.');

    // Primary team 节
    expect(result).toContain('### Primary team — `primary-team` (id: `team-primary`)');
    expect(result).toContain('Teammate sids: `sid-A`');

    // Multi-team 节
    expect(result).toContain('### Multi-team — other teams **attempted** to adopt as lead');
    expect(result).toContain(
      'verify shared team membership via `list_sessions` before messaging — partial adopt may have failed for some teams',
    );
    expect(result).toContain('- Team `team-two` (id: `team-2`): teammate sids `sid-X`, `sid-Y`');
    expect(result).toContain('- Team `team-three` (id: `team-3`): teammate sids `sid-Z`');
  });

  it('empty teammate list: Primary team 内无 teammate → 显示 `(none)` placeholder', () => {
    const result = buildAdoptedTeamsContextBlock({
      firstTeam: {
        id: 'team-solo',
        name: 'solo-team',
        teammateSids: [],
      },
      otherLeadTeams: [],
    });

    expect(result).toContain('### Primary team — `solo-team` (id: `team-solo`)');
    expect(result).toContain('Teammate sids: (none)');
  });

  it('multi-team with empty teammate list: 同款 (none) placeholder', () => {
    const result = buildAdoptedTeamsContextBlock({
      firstTeam: {
        id: 'team-1',
        name: 'team-with-mates',
        teammateSids: ['sid-A'],
      },
      otherLeadTeams: [
        { id: 'team-2', name: 'empty-team', teammateSids: [] },
      ],
    });

    expect(result).toContain('- Team `empty-team` (id: `team-2`): teammate sids (none)');
  });

  it('Round 7 MED-1 修法: prompt 不含 newSid placeholder 字串 (e.g. __ADOPT_NEW_LEAD_SID__)', () => {
    // 旧 v7 设计要求 spawn 之后 mutate prompt 替换 __ADOPT_NEW_LEAD_SID__,v8 改为
    // helper 用 "You (the new SDK session)" 文案不依赖 newSid 字面值。本守门确保 helper
    // 不含任何 placeholder 字串遗留。
    const result = buildAdoptedTeamsContextBlock({
      firstTeam: {
        id: 'team-id',
        name: 'team-name',
        teammateSids: ['sid-1'],
      },
      otherLeadTeams: [],
    });

    expect(result).not.toContain('__ADOPT_NEW_LEAD_SID__');
    expect(result).not.toContain('__NEW_LEAD_SID__');
    // 应该用 "You (the new SDK session)" 文案
    expect(result).toContain('You (the new SDK session)');
  });

  it('snapshot 完整防漂移 (single-team): 完整字段 input → output 字面快照', () => {
    const result = buildAdoptedTeamsContextBlock({
      firstTeam: {
        id: 'tid-aaa',
        name: 'team-snap',
        teammateSids: ['sid-1', 'sid-2'],
      },
      otherLeadTeams: [],
    });

    // 字面快照保护:任一行字段 / 文案 / spacing 调整都会让本 snapshot fail,强制 SSOT
    // (helper 改 → 本 test fail / hand-off-session.ts adopt 测试 substring fail 双向防漂移)
    expect(result).toBe(
      `## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)\n` +
        `\n` +
        `You (the new SDK session) just became lead of 1 team via hand_off_session adopt path.\n` +
        `The previous caller has handed off this baton and exited — you should not try to reply to them.\n` +
        `\n` +
        `### Primary team — \`team-snap\` (id: \`tid-aaa\`)\n` +
        `Teammate sids: \`sid-1\`, \`sid-2\`\n` +
        `\n` +
        `### How to communicate with teammates\n` +
        `Use \`send_message({ session_id: <teammate-sid>, team_id: <team-id>, text: ... })\` — for first-turn message omit \`reply_to_message_id\`.\n` +
        `Teammates' first reply will auto-include wire prefix \`[from <name>][msg <id>][sid <sid>]\` — use \`reply_to_message_id\` from that prefix on subsequent send_message to maintain reply chain.\n`,
    );
  });

  it('snapshot 完整防漂移 (multi-team N=2): Primary + Multi-team 节 + attempted warning', () => {
    const result = buildAdoptedTeamsContextBlock({
      firstTeam: {
        id: 'tid-1',
        name: 'team-1',
        teammateSids: ['sid-1'],
      },
      otherLeadTeams: [
        { id: 'tid-2', name: 'team-2', teammateSids: ['sid-2', 'sid-3'] },
      ],
    });

    expect(result).toBe(
      `## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)\n` +
        `\n` +
        `You (the new SDK session) just became lead of 2 teams via hand_off_session adopt path.\n` +
        `The previous caller has handed off this baton and exited — you should not try to reply to them.\n` +
        `\n` +
        `### Primary team — \`team-1\` (id: \`tid-1\`)\n` +
        `Teammate sids: \`sid-1\`\n` +
        `\n` +
        `### Multi-team — other teams **attempted** to adopt as lead\n` +
        `(verify shared team membership via \`list_sessions\` before messaging — partial adopt may have failed for some teams)\n` +
        `- Team \`team-2\` (id: \`tid-2\`): teammate sids \`sid-2\`, \`sid-3\`\n` +
        `\n` +
        `### How to communicate with teammates\n` +
        `Use \`send_message({ session_id: <teammate-sid>, team_id: <team-id>, text: ... })\` — for first-turn message omit \`reply_to_message_id\`.\n` +
        `Teammates' first reply will auto-include wire prefix \`[from <name>][msg <id>][sid <sid>]\` — use \`reply_to_message_id\` from that prefix on subsequent send_message to maintain reply chain.\n`,
    );
  });
});
