/**
 * Agent Teams team_name 反向同步收口（CHANGELOG_46）。
 *
 * **背景**：用户在 NewSessionDialog 不再预填 team 名（CHANGELOG_46 起删了输入框）；team
 * 名完全由 lead Claude 在会话内自由决定（自创 / hash / 起任意名）。应用层需要从 SDK 真值
 * 反向同步到 `sessions.team_name` DB 列，否则 TeamHub / SessionCard / inbox-watcher 都不知道
 * 当前 SDK 会话挂在哪个 team。
 *
 * **三层反向同步**（按时效性排）：
 *
 * 1. **PreToolUse hook 拦截**（最早，决策瞬间）：lead 决定调内置工具
 *    `TeamCreate / TeamDelete / Teammate / SendMessage` 时 CLI emit PreToolUse hook，应用从
 *    `tool_input` 抽 team 名（[hook-routes.ts](../adapters/claude-code/hook-routes.ts) 入口
 *    调 `extractTeamNameFromToolInput` + `sync()`）
 * 2. **Fs add `~/.claude/teams/<X>/config.json`**（CLI 真写 fs 那一刻 ~几百 ms 后）：
 *    chokidar root watcher 捕获 → 读 config.json 取 leadSessionId → 调 `sync()`
 * 3. **Hook 通道补强**（TeammateIdle / TaskCreated / TaskCompleted，几分钟后）：payload 已含
 *    `team_name`，[hook-routes.ts](../adapters/claude-code/hook-routes.ts) 各 handler 加一行
 *    `sync()`
 *
 * 三个 source 走同一收口 `sync(sessionId, teamName, source)`，幂等可重复调用。
 *
 * **不动 fs**：保留 [team-fs.ts:1-20](./team-fs.ts) 「应用绝对不写 ~/.claude/teams/」历史约定；
 * 应用只**读**配置反查 leadSessionId，不改 fs（不 rename 不 patch config.json.name）。
 *
 * **设计实证**：CLI 二进制 strings 出 `TeamCreate / TeamDelete / Teammate / SendMessage`
 * 是 builtin 工具名（PreToolUse hook 必拦）。HOOK_EVENTS 28 个里**没有** TeamCreated /
 * TeammateSpawned create 类 event（只有 TeammateIdle / TaskCreated / TaskCompleted 含
 * team_name 的 hook，时效都比 PreToolUse 晚），所以 PreToolUse 是最优主路径。
 */
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { getTeamsRoot } from './team-fs';

const AWAIT_WRITE_FINISH = { stabilityThreshold: 250, pollInterval: 100 } as const;

/** 三层反向同步的来源标记，仅用于 console.log。 */
export type TeamNameSource = 'pretool' | 'fs' | 'hook';

class TeamCoordinator {
  private rootWatcher: FSWatcher | null = null;
  /**
   * realpath 化后的 teams root（chokidar 在 macOS fsevents 下回 realpath 路径，与 raw symlink
   * path 严格 startsWith 比较失败 → fs 通道完全静默失效，实测踩过）。startFsWatcher 时一次性
   * 缓存，processConfigFile 用它做前缀比对。未启动 watcher 时为 null。
   */
  private realRoot: string | null = null;

  /**
   * REVIEW_17 R1 / M6：team unset dedup 窗口。force-cleanup IPC handler 主动
   * unset + chokidar unlinkDir 兜底 unset 是同一逻辑两路触发，第二次 SELECT/UPDATE
   * 必返回空（行已 NULL）但仍浪费一次 SQL 往返。30s 窗口足够覆盖 chokidar
   * unlinkDir 延迟（< 1s 典型）+ awaitWriteFinish 250ms。
   */
  private recentlyUnset = new Map<string, number>();
  private static readonly UNSET_DEDUP_MS = 30_000;

  /**
   * 单一收口：把 (sessionId, teamName) 反向写到 sessions.team_name DB 列。
   *
   * - 幂等：如果 DB 已有相同值 → no-op
   * - 不属于应用管理的 session（独立终端 claude / 已 closed） → no-op，不动
   * - 写完 emit `session-upserted` 触发 inbox-watcher refreshAutoSubscribe + renderer 刷新
   */
  sync(sessionId: string, teamName: string, source: TeamNameSource): void {
    if (!sessionId || !teamName) return;
    const s = sessionRepo.get(sessionId);
    if (!s) return;
    if (s.teamName === teamName) return;

    sessionRepo.setTeamName(sessionId, teamName);
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
    console.log(
      `[team-coordinator] sync from ${source}: session=${sessionId} team=${teamName} (was: ${s.teamName ?? 'null'})`,
    );
  }

  /**
   * 启动 chokidar root watcher 监听 `~/.claude/teams/<X>/config.json`（add / change），
   * 反向同步到 DB（`source='fs'`）。
   *
   * - `ignoreInitial: false`：应用启动时 replay 现存 config.json，处理离线期间 lead 已建的 team
   *   / pretool race 漏过的 / hook 没装场景
   * - `awaitWriteFinish: 250ms`：避免半截 JSON
   * - 任何 IO / parse 失败都吞到 console.warn，不抛错
   */
  startFsWatcher(): void {
    if (this.rootWatcher) return; // 幂等
    const rootRaw = getTeamsRoot();
    // realpath 化 root（详见 realRoot 字段注释）。teams root 不存在时（首次跑应用、还没建过
    // team）保留 raw 路径让 chokidar 等目录创建——但事后比较仍可能失败，下次 startFsWatcher
    // 重启时会修正；可接受边角。
    this.realRoot = existsSync(rootRaw) ? realpathSync(rootRaw) : rootRaw;
    const root = this.realRoot;
    // glob 模式：监听 root 下任何 <name>/config.json（depth 2）
    const pattern = join(root, '*', 'config.json');
    this.rootWatcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: AWAIT_WRITE_FINISH,
    });
    const handle = (filepath: string): void => {
      void this.processConfigFile(filepath);
    };
    this.rootWatcher.on('add', handle);
    this.rootWatcher.on('change', handle);
    this.rootWatcher.on('error', (err) => {
      console.warn('[team-coordinator] root watcher error:', err);
    });
    console.log(`[team-coordinator] fs watcher started @ ${root}`);
  }

  async shutdown(): Promise<void> {
    if (!this.rootWatcher) return;
    try {
      await this.rootWatcher.close();
    } catch (err) {
      console.warn('[team-coordinator] root watcher close failed:', err);
    }
    this.rootWatcher = null;
  }

  /**
   * REVIEW_17 R1 / M6：unset 一个 team 名下所有 sessions 的 team_name + emit
   * upserts 让 renderer 同步。force-cleanup IPC handler 与 chokidar unlinkDir
   * 兜底两个入口都调这里收口，30s 内重复 unset 直接 no-op，避免 N+1 SQL 浪费。
   *
   * 返回 unset 的 session id 列表（首次调有，dedup 命中返 []）。调用方按需自己
   * 决定是否还要补 emit（典型场景两个入口都不需要补 — 第一次已 emit 了）。
   */
  unsetTeamFromAllSessions(teamName: string): string[] {
    if (!teamName) return [];
    const last = this.recentlyUnset.get(teamName);
    const now = Date.now();
    if (last !== undefined && now - last < TeamCoordinator.UNSET_DEDUP_MS) {
      return [];
    }
    this.recentlyUnset.set(teamName, now);
    // 顺手清掉过期的 dedup 条目（避免 Map 无限涨；team unset 是低频事件）
    for (const [k, ts] of this.recentlyUnset) {
      if (now - ts > TeamCoordinator.UNSET_DEDUP_MS) this.recentlyUnset.delete(k);
    }
    let affected: string[];
    try {
      affected = sessionRepo.clearTeamName(teamName);
    } catch (err) {
      console.warn(`[team-coordinator] unsetTeamFromAllSessions clearTeamName failed for "${teamName}":`, err);
      return [];
    }
    for (const sid of affected) {
      const s = sessionRepo.get(sid);
      if (s) eventBus.emit('session-upserted', s);
    }
    return affected;
  }

  /** 读 ~/.claude/teams/<name>/config.json 反查 leadSessionId 调 sync。 */
  private async processConfigFile(filepath: string): Promise<void> {
    if (!existsSync(filepath)) return;
    // 解析 actualName：<root>/<name>/config.json → <name>
    // root 用 startFsWatcher 时缓存的 realpath 化路径（见 realRoot 字段注释）；filepath 来自
    // chokidar 也是 realpath 化的，前缀比对自然成立。
    const root = this.realRoot ?? getTeamsRoot();
    if (!filepath.startsWith(root)) return;
    const rest = filepath.slice(root.length).replace(/^\/+/, '');
    const segs = rest.split('/');
    if (segs.length !== 2 || segs[1] !== 'config.json') return; // 只关心 *<name>/config.json，深层不管
    const actualName = segs[0];
    if (!actualName) return;

    let leadSessionId: string | undefined;
    try {
      const text = await readFile(filepath, 'utf8');
      const parsed = JSON.parse(text) as { leadSessionId?: unknown };
      if (typeof parsed.leadSessionId === 'string' && parsed.leadSessionId) {
        leadSessionId = parsed.leadSessionId;
      }
    } catch (err) {
      console.warn(`[team-coordinator] read/parse failed @ ${filepath}:`, err);
      return;
    }
    if (!leadSessionId) return;
    this.sync(leadSessionId, actualName, 'fs');
  }
}

export const teamCoordinator = new TeamCoordinator();

/**
 * 从 PreToolUse 的 `tool_name` + `tool_input` 抽 team 名。CLI builtin 工具：
 * - `TeamCreate` / `TeamDelete`：创建 / 删除 team
 * - `Teammate`：spawn / 操作 teammate（含子操作）
 * - `SendMessage`：lead 给 teammate 发消息
 *
 * **未实证**：CLI 实际 `tool_input` 字段名（`name` vs `team_name` vs `team` vs `teamName`）。
 * 本 helper 同时尝试多个常见字段名 + console.log 命中实情。首次实测后保留对应分支。
 *
 * REVIEW_17 R2 / M2-R2：返回值走与 ipc.ts parseTeamName 同款规范化（trim + 严格
 * charset）—— 否则 lead 调 `TeamCreate(name="  team-A  ")` 时反向同步写到 DB 的是带
 * 空白的字符串，inbox-watcher.subscribe 走 slugify 后路径 `--team-A--` 与 fs 实际
 * 目录 `team-A` 错位 → chokidar 永远 fire 不到 → permission_request 全丢。
 *
 * 不命中 / 不是 team 工具 / 校验失败 → 返回 null，hook handler 不调 sync（fs / hook 通道兜底）。
 */
const TEAM_NAME_CHARSET = /^[A-Za-z0-9._-]+$/;
function normalizeTeamName(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (!TEAM_NAME_CHARSET.test(trimmed)) return null;
  return trimmed;
}

export function extractTeamNameFromToolInput(
  toolName: string,
  input: unknown,
): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const pickStr = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  };
  let raw: string | null;
  switch (toolName) {
    case 'TeamCreate':
    case 'TeamDelete':
      raw = pickStr('name', 'team_name', 'teamName', 'team');
      break;
    case 'Teammate':
    case 'SendMessage':
      raw = pickStr('team_name', 'teamName', 'team');
      break;
    default:
      return null;
  }
  return normalizeTeamName(raw);
}
