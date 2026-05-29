/**
 * task tool external caller 边界测试（plan task-mcp-merge-into-agent-deck-mcp-20260521 §D6 + R1 F1 + R2 F-R2-5
 * + plan task-team-id-restore-20260525 §D8 flip false）。
 *
 * 验 5 个 task tool 在 EXTERNAL_CALLER_ALLOWED Record 严格类型下的 deny / allow 决策：
 * - task_create / task_update / task_delete / task_get：external caller (sentinel) 写/读 → DENY
 * - task_list：external caller (sentinel) 读 → ALLOW（只 list 是 read-only cross-team scope）
 *
 * **v024 plan §D8 修法**(user 拍板方案 A): task_get 从 ALLOW → DENY,与 task_create/update/delete
 * 同款 deny external 对称。v023 「external mcp client 凭已知 taskId 查 task」use case 被推翻 —
 * external client 仅能走 task_list 拉自己可见 scope（对未 join team 的 external client 返空）。
 *
 * 与 spoofing-attack-paths.test.ts 角色边界：
 * - spoofing：端到端 4 段防御链（transport override + makeCtx + makeCallerContext + denyExternalIfNotAllowed）
 *   验证攻击向量阻断 + 合法路径通过 + read-only 例外
 * - **本测试**：聚焦 D6 + D8 task tool 视角，按 EXTERNAL_CALLER_ALLOWED 矩阵 1:1 验证 5 tool deny / allow 矩阵
 *
 * R2 F-R2-5 修订：HTTP + stdio external transport 都覆盖。
 */

import { describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));

import { denyExternalIfNotAllowed } from '../tools/helpers';
import {
  EXTERNAL_CALLER_ALLOWED,
  EXTERNAL_CALLER_SENTINEL,
  type CallerContext,
} from '../types';

function ctx(
  callerSessionId: string,
  transport: CallerContext['transport'],
): CallerContext {
  return { callerSessionId, transport };
}

describe('task tool external caller 决策矩阵（D6）', () => {
  it('EXTERNAL_CALLER_ALLOWED 5 task tool 显式 5 entries（R1 F1 修法 + v024 D8 task_get flip false）', () => {
    // R1 F1: Record<AgentDeckToolName, boolean> 严格类型不存在「不加 = allow」语义；
    // 必须 5 entries 全显式赋值。
    // v024 plan §D8: task_get flip false（与 task_create/update/delete 同款 deny external 对称）。
    expect(EXTERNAL_CALLER_ALLOWED.task_create).toBe(false);
    expect(EXTERNAL_CALLER_ALLOWED.task_update).toBe(false);
    expect(EXTERNAL_CALLER_ALLOWED.task_delete).toBe(false);
    expect(EXTERNAL_CALLER_ALLOWED.task_list).toBe(true);
    expect(EXTERNAL_CALLER_ALLOWED.task_get).toBe(false); // v024 D8: 推翻 v023 cross-team 可读
  });

  describe('HTTP transport（fallbackToGlobal sentinel）', () => {
    const httpExtCtx = ctx(EXTERNAL_CALLER_SENTINEL, 'http');

    it.each(['task_create', 'task_update', 'task_delete', 'task_get'] as const)(
      '4 写/read DENY tool 全 DENY: %s (v024 D8 task_get 加入)',
      (tool) => {
        const denial = denyExternalIfNotAllowed(tool, httpExtCtx);
        expect(denial).not.toBeNull();
        expect(denial?.isError).toBe(true);
        expect(JSON.parse(denial!.content[0].text).error).toMatch(
          new RegExp(`${tool} not allowed for external caller`),
        );
      },
    );

    it.each(['task_list'] as const)('1 读 tool ALLOW: %s (v024 D8: task_get 移出 read-only allow)', (tool) => {
      const denial = denyExternalIfNotAllowed(tool, httpExtCtx);
      expect(denial).toBeNull();
    });
  });

  describe('stdio transport (sentinel — transport-stdio.ts force)', () => {
    const stdioExtCtx = ctx(EXTERNAL_CALLER_SENTINEL, 'stdio');

    it.each(['task_create', 'task_update', 'task_delete', 'task_get'] as const)(
      '4 写/read DENY tool 全 DENY: %s (v024 D8 task_get 加入)',
      (tool) => {
        const denial = denyExternalIfNotAllowed(tool, stdioExtCtx);
        expect(denial).not.toBeNull();
        expect(denial?.isError).toBe(true);
      },
    );

    it.each(['task_list'] as const)('1 读 tool ALLOW: %s (v024 D8: task_get 移出 read-only allow)', (tool) => {
      const denial = denyExternalIfNotAllowed(tool, stdioExtCtx);
      expect(denial).toBeNull();
    });

    it('stdio + 非 sentinel callerSid（transport 漏改假设）+ 写 → invariant violation DENY', () => {
      // helpers.ts (a) 兜底：stdio + 非 sentinel callerSid → DENY 防 transport 层漏改回归
      const malformed = ctx('attacker-injected-sid', 'stdio');
      const denial = denyExternalIfNotAllowed('task_create', malformed);
      expect(denial).not.toBeNull();
      expect(JSON.parse(denial!.content[0].text).error).toMatch(
        /not allowed for stdio transport with non-sentinel/,
      );
    });
  });

  describe('in-process transport（closure override，永真路径）', () => {
    it('in-process + real sid + 写 tool → ALLOW（closure 永远 override 真 sid，跳两条 deny 路径）', () => {
      const inProcCtx = ctx('sdk-owner-real-sid', 'in-process');
      for (const tool of [
        'task_create',
        'task_update',
        'task_delete',
        'task_list',
        'task_get',
      ] as const) {
        expect(denyExternalIfNotAllowed(tool, inProcCtx)).toBeNull();
      }
    });
  });
});
