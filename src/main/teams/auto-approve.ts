/**
 * Teammate 权限 auto-approve 决策（CHANGELOG_<X> B3）。
 *
 * **背景**：Agent Teams in-process backend 的 teammate 调工具走 inbox 协议
 * （`~/.claude/teams/<X>/inboxes/team-lead.json`），**不会**回到 lead 的 SDK
 * canUseTool 回调（CHANGELOG_45 第一句铁证），所以 lead 的 permissionMode /
 * READ_ONLY_TOOLS 白名单 / settings.json permissions.allow 在 teammate 这边全失效。
 *
 * 应用层在 inbox-watcher 检测到 permission_request 时按 settings.autoApproveTeammateMode
 * 调 shouldAutoApprove 决定是否主动写 inbox response allow，跳过 UI 弹框。
 *
 * 三档语义见 settings.ts AppSettings.autoApproveTeammateMode JSDoc。
 *
 * **不做 Bash 自动放行**：即便 lead 在 acceptEdits 模式下 Bash 也会被 SDK 弹（acceptEdits
 * 只放行 Edit/Write 类工具），与之对齐 follow-lead acceptEdits 档也只加放行 EDIT_TOOLS。
 * lead bypassPermissions 是用户明确拍板的「完全免询问」档，teammate 这边自然全放行；其他
 * 档（default / plan / null）一律降级到 read-only。
 */
import {
  EDIT_TOOLS,
  READ_ONLY_TOOLS,
  isImageReadTool,
  isTaskMcpTool,
} from '@shared/constants/read-only-tools';
import type { AppSettings, PermissionMode } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { readTeamConfig } from './team-fs';

export interface AutoApproveDecision {
  approve: boolean;
  /** console.log 用的人类可读理由（auto-approve / fallback / mode=off / no-rule-match）。 */
  reason: string;
}

/**
 * 按 mode + leadPermissionMode + 工具名决定是否 auto-approve。纯函数 / 同步 / 无 IO。
 *
 * 决策矩阵（顺序判断 short-circuit）：
 * - mode='off' → 永不
 * - mode='read-only' / 'follow-lead'：read-only 白名单（READ_ONLY_TOOLS / __ImageRead /
 *   mcp__tasks__*）→ 自动允许
 * - mode='follow-lead'：lead bypassPermissions → 自动允许；lead acceptEdits + 命中
 *   EDIT_TOOLS → 自动允许；其他 → 降级 fallback
 * - 默认 → 不允许
 */
export function shouldAutoApprove(
  toolName: string,
  mode: AppSettings['autoApproveTeammateMode'],
  leadPermissionMode: PermissionMode | null,
): AutoApproveDecision {
  if (mode === 'off') {
    return { approve: false, reason: 'mode=off' };
  }
  // read-only 白名单（read-only 与 follow-lead 档共享这条基线）
  if (READ_ONLY_TOOLS.has(toolName) || isImageReadTool(toolName) || isTaskMcpTool(toolName)) {
    return { approve: true, reason: 'read-only-whitelist' };
  }
  if (mode === 'follow-lead') {
    if (leadPermissionMode === 'bypassPermissions') {
      return { approve: true, reason: 'follow-lead-bypass' };
    }
    if (leadPermissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) {
      return { approve: true, reason: 'follow-lead-acceptEdits' };
    }
    // lead default / plan / null 都走 fallback（保守地降级到 read-only 白名单已上面命中）
    return { approve: false, reason: 'follow-lead-fallback' };
  }
  // mode='read-only' 但工具不在白名单 → 不允许（弹给用户）
  return { approve: false, reason: 'no-rule-match' };
}

/**
 * 反查指定 team 的 lead session 当前 permissionMode（CHANGELOG_<X> B3 / reviewer-claude MED 修复）。
 *
 * 三级回退：
 * 1. **优先 fs SSOT**：`readTeamConfig(teamName).raw.leadSessionId`（CHANGELOG_46 已确立 fs
 *    是 leadSessionId 的真值），再 `sessionRepo.get(leadSessionId)?.permissionMode`
 * 2. **退化**：fs 拿不到（config.json 不存在 / parse 失败 / leadSessionId 缺）→
 *    `sessionRepo.findByTeamName(teamName)` 过滤 source='sdk' 后取 lastEventAt 最新
 *    （**不**过滤 lifecycle / archivedAt——按 CLAUDE.md「鉴权与会话边界」节，归档 / dormant
 *    的 lead 仍是 lead，「lead 离线但 teammate 还在跑」是合理边界）
 * 3. 都没找到 → 返回 `null`（视为 default，shouldAutoApprove 走 follow-lead-fallback 降级）
 *
 * 任何 IO / parse 失败一律 swallow 到 console.warn 后走 fallback，绝不抛错（inbox-watcher
 * 调用方在 hot path 上不能因为读 config 失败炸链）。
 */
export async function lookupLeadPermissionMode(
  teamName: string,
): Promise<PermissionMode | null> {
  // 第 1 级：fs SSOT
  try {
    const cfg = await readTeamConfig(teamName);
    const rawLeadSid =
      cfg && cfg.raw && typeof cfg.raw.leadSessionId === 'string' ? cfg.raw.leadSessionId : null;
    if (rawLeadSid) {
      const leadSession = sessionRepo.get(rawLeadSid);
      if (leadSession) {
        return leadSession.permissionMode ?? null;
      }
    }
  } catch (err) {
    console.warn(`[auto-approve] readTeamConfig failed for "${teamName}":`, err);
  }
  // 第 2 级：DB 启发式（fs 拿不到 / sessionRepo 没找到）
  try {
    const candidates = sessionRepo
      .findByTeamName(teamName)
      .filter((s) => s.source === 'sdk');
    if (candidates.length === 0) return null;
    // findByTeamName 已经按 lastEventAt DESC 排序（session-repo.ts:217 SQL ORDER BY），
    // 取 [0] 就是最新；不过滤 lifecycle / archivedAt 详见 JSDoc 边界说明
    return candidates[0].permissionMode ?? null;
  } catch (err) {
    console.warn(`[auto-approve] findByTeamName fallback failed for "${teamName}":`, err);
    return null;
  }
}
