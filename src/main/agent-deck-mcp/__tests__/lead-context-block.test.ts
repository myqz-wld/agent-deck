/**
 * lead-context-block.ts 单测(plan hand-off-session-adopt-teammates-20260520 Phase 4 step 1c
 * snapshot test 双向防漂移 — Round 4 NEW MED-B 修法 SSOT 唯一化)。
 *
 * **防漂移机制**:
 * - 本文件 input → output snapshot 测试(包括 wirePrefix 各段 + contextBlock 字段)
 * - tools.test.ts spawn placeholder body 断言用 substring 验证 helper 输出包含
 *   `## Hand-off context (auto-injected by Agent Deck MCP)` 等关键字串
 * - 任一处 helper 字段调整 → 两处 test 同步 fail 强制 SSOT 不漂移
 *
 * **不复用 adopt 路径**:helper 仅给 spawn 用,adopt 路径走独立
 * `adopted-teams-context-block.ts`(Phase 4c)— 详 lead-context-block.ts 顶部 jsdoc。
 */

import { describe, it, expect } from 'vitest';
import { buildLeadContextBlock } from '../tools/handlers/lead-context-block';

describe('buildLeadContextBlock — spawn 路径 wire prefix + lead context block 装配', () => {
  it('happy path: 完整字段 → wirePrefix 三段 + contextBlock 字段', () => {
    const result = buildLeadContextBlock({
      leadSessionId: 'lead-sid-12345678-90ab-cdef-1234-567890abcdef',
      teamId: 'team-id-deadbeef',
      leadDisplayName: 'Lead User',
      leadAdapter: 'claude-code',
      placeholderId: '11111111-2222-3333-4444-555555555555',
    });

    // wire prefix 三段格式 `[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n`
    expect(result.wirePrefix).toBe(
      '[from Lead User @ claude-code][msg 11111111-2222-3333-4444-555555555555][sid lead-sid-12345678-90ab-cdef-1234-567890abcdef]\n',
    );

    // contextBlock 含核心字段
    expect(result.contextBlock).toContain('## Hand-off context (auto-injected by Agent Deck MCP)');
    expect(result.contextBlock).toContain('Lead sessionId: `lead-sid-12345678-90ab-cdef-1234-567890abcdef`');
    expect(result.contextBlock).toContain('Team id: `team-id-deadbeef`');
    expect(result.contextBlock).toContain('Lead displayName: Lead User');
    expect(result.contextBlock).toContain('Reply to the lead with Agent Deck MCP after you finish this turn:');
    expect(result.contextBlock).toContain('mcp__agent-deck__send_message({');
    expect(result.contextBlock).toContain("sessionId: 'lead-sid-12345678-90ab-cdef-1234-567890abcdef',");
    expect(result.contextBlock).toContain("teamId: 'team-id-deadbeef',");
    expect(result.contextBlock).toContain('replyToMessageId:');
    expect(result.contextBlock).toContain('Extract `replyToMessageId` from the top wire prefix `[msg <id>]`.');
  });

  it('leadDisplayName=null → contextBlock 显示 `(unset)` + wirePrefix from name fallback `<adapter>:<sid 前 8>`', () => {
    const result = buildLeadContextBlock({
      leadSessionId: 'abc12345-fff0-fff0-fff0-fff0fff0fff0',
      teamId: 'team-foo',
      leadDisplayName: null,
      leadAdapter: 'codex-cli',
      placeholderId: 'msg-id-zzz',
    });

    // wirePrefix from name fallback `<leadAdapter>:<lead-sid 前 8>` (8 chars)
    expect(result.wirePrefix).toBe('[from codex-cli:abc12345 @ codex-cli][msg msg-id-zzz][sid abc12345-fff0-fff0-fff0-fff0fff0fff0]\n');
    // contextBlock 内 Lead displayName 行显示 `(unset)`(明示 unset 状态而非 fallback 字串伪装)
    expect(result.contextBlock).toContain('Lead displayName: (unset)');
  });

  it('CHANGELOG_100 R2 fix: leadDisplayName 含 wire prefix 特殊字符 `]` / `\\n` / `[` → sanitize', () => {
    const result = buildLeadContextBlock({
      leadSessionId: 'lead-malicious-sid',
      teamId: 'team-malicious',
      leadDisplayName: 'feat: [test]\nmalicious',
      leadAdapter: 'claude-code',
      placeholderId: 'placeholder-id',
    });

    // wirePrefix `[from <name> @ <adapter>]` 内不该含 raw `]` / `[` / `\n`(被 sanitize 替换)
    // sanitizeWireFieldName 实现: `]` → `)`, `[` → `(`, `\n` → ` `(详 @shared/wire-prefix)
    const fromMatch = result.wirePrefix.match(/^\[from (.+) @ /);
    expect(fromMatch).not.toBeNull();
    const sanitizedFromName = fromMatch![1];
    expect(sanitizedFromName).not.toContain(']');
    expect(sanitizedFromName).not.toContain('[');
    expect(sanitizedFromName).not.toContain('\n');
  });

  it('leadAdapter sanitize: 含 `]` / `[` 字符 → 同款替换', () => {
    const result = buildLeadContextBlock({
      leadSessionId: 'lead-sid',
      teamId: 'team-id',
      leadDisplayName: 'Lead',
      leadAdapter: 'evil[adapter]',
      placeholderId: 'pid',
    });

    const adapterMatch = result.wirePrefix.match(/@ (.+)\]\[msg /);
    expect(adapterMatch).not.toBeNull();
    const sanitizedAdapter = adapterMatch![1];
    expect(sanitizedAdapter).not.toContain('[');
    expect(sanitizedAdapter).not.toContain(']');
  });

  it('snapshot 完整防漂移: 完整字段 input → output 字面快照', () => {
    const result = buildLeadContextBlock({
      leadSessionId: 'sid-aaaa',
      teamId: 'tid-bbbb',
      leadDisplayName: 'Snapshot Lead',
      leadAdapter: 'claude-code',
      placeholderId: 'pid-cccc',
    });

    // 字面快照保护:任一行字段 / 文案 / spacing 调整都会让本 snapshot fail,强制 SSOT 唯一化
    // (helper 改 → 本 test fail / spawn.ts 调用 → tools.test.ts substring fail 双向防漂移)
    expect(result.wirePrefix).toBe('[from Snapshot Lead @ claude-code][msg pid-cccc][sid sid-aaaa]\n');
    expect(result.contextBlock).toBe(
      `## Hand-off context (auto-injected by Agent Deck MCP)\n` +
        `- Lead sessionId: \`sid-aaaa\`\n` +
        `- Team id: \`tid-bbbb\`\n` +
        `- Lead displayName: Snapshot Lead\n` +
        `\n` +
        `Reply to the lead with Agent Deck MCP after you finish this turn:\n` +
        `\`\`\`\n` +
        `mcp__agent-deck__send_message({\n` +
        `  sessionId: 'sid-aaaa',  // lead sessionId\n` +
        `  teamId: 'tid-bbbb',  // current team id\n` +
        `  text: '<reply text>',\n` +
        `  replyToMessageId: '<msg-id from wire prefix>'\n` +
        `})\n` +
        `\`\`\`\n` +
        `Extract \`replyToMessageId\` from the top wire prefix \`[msg <id>]\`. Reply to the actual sender in \`[sid <senderSid>]\`; for later or rescue messages, replace the example \`sessionId\` above with that sender sid.\n`,
    );
  });
});
