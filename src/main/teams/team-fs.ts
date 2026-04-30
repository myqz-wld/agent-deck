/**
 * Agent Teams M2 — fs 只读访问层。
 *
 * 数据源：
 * - `~/.claude/teams/<name>/config.json` —— Claude Code agent teams 自管的成员清单
 * - `~/.claude/tasks/<name>/<task-list>.md` —— Claude 自管的 shared task list
 *
 * **应用绝对不写**：team config 与 task list 完全由 Claude 维护（cleanup / spawn / shutdown
 * 都由 lead 内部走 TeamCreate / TeamDelete / TeammateTool 协议改）。本模块只读。
 *
 * **路径越权防护**：所有 read 入参 name 先走 `validateTeamName` 严格校验（与 IPC
 * `parseTeamName` 同模式：字母数字 . _ - / ≤ 64），然后 path.resolve 后用前缀比对确保
 * 真实路径仍在 teamsRoot / tasksRoot 内（防 symlink TOCTOU 越权）。renderer 给到非法
 * `name='../foo'` 直接 throw。
 *
 * **schema 宽容**：config.json 是 Claude 实验特性产物，schema 可能演进。解析时仅强约束
 * `members` 是数组、`name` 是 string；其他字段全可选 + 原样保留在 raw 里，让 UI 调试入口
 * 能看到全部。corrupt JSON / 文件不存在 / 权限拒绝 → 全部返回 null（不抛错），上层 UI
 * 自己决定显示「成员未知」还是别的兜底。
 */
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type {
  AgentEvent,
  SessionRecord,
  TeamConfig,
  TeamMember,
  TeamSnapshot,
  TeamSummary,
} from '@shared/types';

/** ~/.claude/teams 绝对路径（Claude Code 自管的 team config 根）。 */
const teamsRoot = join(homedir(), '.claude', 'teams');
/** ~/.claude/tasks 绝对路径（Claude Code 自管的 shared task list 根）。 */
const tasksRoot = join(homedir(), '.claude', 'tasks');

export function getTeamsRoot(): string {
  return teamsRoot;
}

export function getTasksRoot(): string {
  return tasksRoot;
}

/**
 * Team 名校验（与 IPC parseTeamName 同规则）。失败 throw，调用方负责 catch 转 IPC 错。
 * 抛错而非返回 boolean：让违法名字一进来就显式失败，避免后续路径拼接才发现越权。
 */
function validateTeamName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`invalid team name: must be non-empty string, got ${typeof name}`);
  }
  if (name.length > 64) {
    throw new Error(`invalid team name: length > 64 (got ${name.length})`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid team name: must match /^[A-Za-z0-9._-]+$/, got "${name}"`);
  }
}

/**
 * 把任意路径展平 + 校验仍在指定 root 前缀内（防 symlink 越权）。
 *
 * **target 与 root 必须用同一种形态比对**（要么都 realpath，要么都 resolve）：
 * - target **存在** → 两边都 realpath（解 symlink，处理 ~/.claude → ~/.claude-default 这种链）
 * - target **不存在** → 两边都用 resolve（不解 symlink）；理由：target 不存在 → 无文件
 *   可读 → 真实越权风险消失，剩下的就是防 `..` 字面量越权（resolve 已经规范化）
 *
 * 之前曾踩坑：target 不存在时单边 realpath 一边 resolve 形态不一致 → force-cleanup 删完 fs
 * 后 chokidar unlinkDir 事件触发 refresh() → getTeam → readTeamConfig 走到这里，target 已删
 * 退回 resolved（`/Users/apple/.claude/...`），root realpath 成功（`/Users/apple/.claude-default/...`）
 * → 前缀对不上误报「path escape」让 UI 短暂闪红条。
 *
 * 与 image-load 越权防护同模式（详见 src/main/index.ts 的 ImageLoadBlob handler）。
 */
async function ensureWithinRoot(target: string, root: string): Promise<string> {
  const targetResolved = resolve(target);
  let targetReal: string | null = null;
  try {
    targetReal = await realpath(targetResolved);
  } catch {
    // target 不存在 → 走 resolved 路径分支
  }

  if (targetReal === null) {
    // target 不存在 → 用 resolved 形态对齐（不能跟 realpath(root) 比，symlink 形态会不一致）
    const rootResolved = resolve(root);
    const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
    if (targetResolved !== rootResolved && !targetResolved.startsWith(rootWithSep)) {
      throw new Error(`path escape detected: ${targetResolved} not under ${rootResolved}`);
    }
    return targetResolved;
  }

  // target 存在 → 用 realpath 形态对齐（处理 symlink 跨边界 + TOCTOU）
  let rootReal = root;
  try {
    rootReal = await realpath(root);
  } catch {
    // root 不存在但 target 存在？罕见边界（typically target 是 symlink 指向 root 外），按越权处理
  }
  const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (targetReal !== rootReal && !targetReal.startsWith(rootWithSep)) {
    throw new Error(`path escape detected: ${targetReal} not under ${rootReal}`);
  }
  return targetReal;
}

/**
 * 列出所有已建 team 的简表。合并两个数据源：
 * - fs `~/.claude/teams/` 子目录（Claude 已建队的真实 team）
 * - 调用方传入的 distinctTeamNames（DB 里 sessions.team_name 出现的 team，可能 fs 还没建好）
 *
 * 合并去重 + 按 name 字典序返回。每条带 hasConfig / hasTasks / mtime / sessionCount /
 * lastEventAt 元信息。
 *
 * @param distinctSqlNames - 来自 sessionRepo.distinctTeamNames()，应用 DB 里出现的 team 名
 * @param sessionsByName - team name → 该 team 名下的 SessionRecord[]，用于算 sessionCount / lastEventAt
 */
export async function listTeams(
  distinctSqlNames: string[],
  sessionsByName: Map<string, SessionRecord[]>,
): Promise<TeamSummary[]> {
  const fsNames = new Set<string>();
  if (existsSync(teamsRoot)) {
    try {
      const entries = await readdir(teamsRoot, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        // 校验目录名仍是合法 team 名（外部手动创建的奇怪目录不展示）
        if (/^[A-Za-z0-9._-]{1,64}$/.test(e.name)) {
          fsNames.add(e.name);
        }
      }
    } catch (err) {
      console.warn('[team-fs] readdir teamsRoot failed:', err);
    }
  }
  const allNames = new Set<string>([...fsNames, ...distinctSqlNames]);
  const summaries: TeamSummary[] = [];
  for (const name of allNames) {
    const teamDir = join(teamsRoot, name);
    const tasksDir = join(tasksRoot, name);
    const hasConfig = existsSync(join(teamDir, 'config.json'));
    const hasTasks = existsSync(tasksDir) && (await hasAnyMarkdown(tasksDir));
    const sessions = sessionsByName.get(name) ?? [];
    const lastEventAt = sessions.length > 0
      ? Math.max(...sessions.map((s) => s.lastEventAt))
      : null;
    summaries.push({
      name,
      sessionCount: sessions.length,
      hasConfig,
      hasTasks,
      lastEventAt,
    });
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}

/** 目录下是否有至少 1 个 .md 文件。 */
async function hasAnyMarkdown(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.some((e) => e.toLowerCase().endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * 读 ~/.claude/teams/<name>/config.json。
 * - 文件不存在 / 权限拒绝 / JSON corrupt → 返回 null（不抛错）
 * - 解析成功但 members 字段不是数组 → members: [] + raw 保留原始 JSON
 */
export async function readTeamConfig(name: string): Promise<TeamConfig | null> {
  validateTeamName(name);
  const configPath = await ensureWithinRoot(join(teamsRoot, name, 'config.json'), teamsRoot);
  if (!existsSync(configPath)) return null;
  let mtime = Date.now();
  try {
    mtime = statSync(configPath).mtimeMs;
  } catch {
    /* mtime 取不到无所谓，用现在 */
  }
  let raw: Record<string, unknown> | null = null;
  try {
    const text = await readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    console.warn(`[team-fs] readTeamConfig parse failed for ${name}:`, err);
    return null;
  }
  const membersRaw = raw && Array.isArray(raw.members) ? (raw.members as unknown[]) : [];
  const members: TeamMember[] = membersRaw
    .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
    .map((m) => {
      const member: TeamMember = { name: typeof m.name === 'string' ? m.name : '(unnamed)' };
      if (typeof m.agentType === 'string') member.agentType = m.agentType;
      if (typeof m.agent_type === 'string') member.agentType = m.agent_type; // schema 兼容
      if (typeof m.agentId === 'string') member.agentId = m.agentId;
      if (typeof m.agent_id === 'string') member.agentId = m.agent_id;
      if (typeof m.sessionId === 'string') member.sessionId = m.sessionId;
      if (typeof m.session_id === 'string') member.sessionId = m.session_id;
      // 其他字段原样保留在 member 里（用 [key]: unknown 兜底接收 schema 演进）
      for (const [k, v] of Object.entries(m)) {
        if (!(k in member)) member[k] = v;
      }
      return member;
    });
  return { members, mtime, raw };
}

/**
 * 找 ~/.claude/tasks/<name>/ 下的 shared task list 文件。
 * Claude 内部约定的文件名可能演进（实验特性），按命名优先级 + 最大 mtime 兜底：
 * 1. `task-list.md` / `tasks.md` / `TODO.md` 任一存在即取
 * 2. 否则取该目录下最大 mtime 的 .md
 * 3. 都没有 → 返回 null
 */
async function findTaskListFile(name: string): Promise<string | null> {
  const tasksDir = await ensureWithinRoot(join(tasksRoot, name), tasksRoot);
  if (!existsSync(tasksDir)) return null;
  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    return null;
  }
  const mdFiles = entries.filter((e) => e.toLowerCase().endsWith('.md'));
  if (mdFiles.length === 0) return null;
  // 优先级匹配
  const preferred = ['task-list.md', 'tasks.md', 'TODO.md'];
  for (const p of preferred) {
    const hit = mdFiles.find((f) => f === p);
    if (hit) return join(tasksDir, hit);
  }
  // 回落：最大 mtime
  let best = mdFiles[0];
  let bestMtime = 0;
  for (const f of mdFiles) {
    try {
      const m = statSync(join(tasksDir, f)).mtimeMs;
      if (m > bestMtime) {
        best = f;
        bestMtime = m;
      }
    } catch {
      /* skip */
    }
  }
  return join(tasksDir, best);
}

/**
 * 读 task list markdown 文件内容 + mtime。文件不存在 / 读失败 → 返回 null。
 */
export async function readTaskList(
  name: string,
): Promise<{ file: string; markdown: string; mtime: number } | null> {
  validateTeamName(name);
  const file = await findTaskListFile(name);
  if (!file) return null;
  try {
    const markdown = await readFile(file, 'utf8');
    const mtime = statSync(file).mtimeMs;
    return { file, markdown, mtime };
  } catch (err) {
    console.warn(`[team-fs] readTaskList read failed for ${name} @ ${file}:`, err);
    return null;
  }
}

/**
 * 一次性拉取一个 team 的完整 snapshot（sessions + config + task list + events）。TeamHub / TeamDetail 用。
 *
 * @param name - team 名（已校验或本函数会 throw）
 * @param sessions - 来自 sessionRepo.findByTeamName(name)，由调用方提供（main IPC handler 拼）
 * @param events - 来自 eventRepo.findTeamEvents(name, 100)，team-* event 时间线（M3）
 */
export async function getTeamSnapshot(
  name: string,
  sessions: SessionRecord[],
  events: AgentEvent[],
): Promise<TeamSnapshot> {
  validateTeamName(name);
  const config = await readTeamConfig(name);
  const tasks = await readTaskList(name);
  return {
    name,
    sessions,
    config,
    taskListFile: tasks?.file ?? null,
    taskListMarkdown: tasks?.markdown ?? null,
    taskListMtime: tasks?.mtime ?? null,
    events,
  };
}

/**
 * Agent Teams M3：手动清理一个 team 的 fs 残留（删 ~/.claude/teams/<name>/ 与 ~/.claude/tasks/<name>/）。
 *
 * 触发场景：Claude Code in-process backend cleanup 上游 bug——teammate `shutdown_approved` 后
 * config.members 不移除 → TeamDelete 永远拒绝。用户手动通过 TeamDetail 「force cleanup」按钮调用。
 *
 * **强约束**：
 * - 路径必须在 teamsRoot / tasksRoot 内（同读取路径走的 ensureWithinRoot）
 * - 仅删两个目录本身，不递归到 ~/.claude/ 其他位置
 * - 任一目录不存在不报错（rm 加 force: true）
 * - 调用方应当先确认无活跃 teammate 在跑（M3 hook 进来后能据 TeammateIdle 推断；M2 阶段
 *   靠用户人工判断 + Claude `Clean up the team` 已尝试过）
 */
export async function forceCleanupTeam(name: string): Promise<{ removed: string[] }> {
  validateTeamName(name);
  const removed: string[] = [];
  for (const root of [teamsRoot, tasksRoot]) {
    const target = await ensureWithinRoot(join(root, name), root);
    if (!existsSync(target)) continue;
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch (err) {
      console.warn(`[team-fs] forceCleanupTeam rm failed for ${target}:`, err);
      throw err;
    }
  }
  return { removed };
}
