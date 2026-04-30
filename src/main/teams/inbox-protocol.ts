/**
 * Agent Teams in-process backend 的 inbox 协议封装。
 *
 * **协议来源**：Claude Agent SDK CLI v0.2.118（实证 strings 自 native binary）。本文件不实现
 * 完整 inbox 工作流，只暴露 agent-deck 需要的最小子集：
 *
 * 1. **路径推导**：`hMH(H, _)` 函数（CLI 内部）拼装 `<homedir>/.claude/teams/<teamSlug>/inboxes/<memberSlug>.json`
 *    其中 slug = `name.replace(/[^a-zA-Z0-9_-]/g, '-')`（CLI 内 `eEH(H)` 函数）。
 * 2. **文件格式**：JSON 数组，每条 `{from, text, timestamp, color?, read}`。`text` 是 stringify 过的
 *    JSON 子消息（type='permission_request' / 'permission_response' / 'mode_set_request' 等）。
 * 3. **锁机制**：`<filepath>.lock`，proper-lockfile，`{retries:10,minTimeout:5,maxTimeout:100}`
 *    （CLI 内部 `O9_` 常量）。两边并发读写不锁会丢消息或损坏 JSON。
 * 4. **permission_response schema**（CLI 内 `Fe6` 函数）：
 *    - success: `{type, request_id, subtype:"success", response:{updated_input, permission_updates}}`
 *    - error: `{type, request_id, subtype:"error", error}`
 * 5. **permission_request schema**（CLI 内 `ge6` 函数）：
 *    - `{type, request_id, agent_id, tool_name, tool_use_id, description, input, permission_suggestions}`
 *
 * 这些字段名 / schema **必须与 CLI 完全一致**，CLI 改了应用就跟着改，不要自创字段。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';

/** Slug 化 team name / member name，与 CLI 内 `eEH(H)` 函数完全一致。 */
export function slugifyMemberName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** Inbox 根目录 `~/.claude/teams`。 */
export function getInboxesRoot(): string {
  return join(homedir(), '.claude', 'teams');
}

/** 单个成员 inbox 文件绝对路径。 */
export function getInboxPath(teamName: string, memberName: string): string {
  return join(
    getInboxesRoot(),
    slugifyMemberName(teamName),
    'inboxes',
    `${slugifyMemberName(memberName)}.json`,
  );
}

/** 一条 inbox 消息（顶层 JSON 数组的元素）。 */
export interface InboxEntry {
  from: string;
  /** stringify 过的 JSON 子消息或纯文本。子消息见 `parseSubMessage`。 */
  text: string;
  timestamp: string;
  color?: string;
  read: boolean;
}

/** permission_request 子消息 schema（与 CLI ge6 函数对齐）。 */
export interface PermissionRequestSubMessage {
  type: 'permission_request';
  request_id: string;
  agent_id: string;
  tool_name: string;
  tool_use_id?: string;
  description?: string;
  input: Record<string, unknown>;
  permission_suggestions?: unknown[];
}

/** permission_response 子消息 schema（与 CLI Fe6 函数对齐）。 */
export type PermissionResponseSubMessage =
  | {
      type: 'permission_response';
      request_id: string;
      subtype: 'success';
      response: {
        updated_input?: Record<string, unknown>;
        permission_updates?: unknown[];
      };
    }
  | {
      type: 'permission_response';
      request_id: string;
      subtype: 'error';
      error: string;
    };

/** mode_set_request 子消息 schema（与 CLI XE9 schema 对齐）。 */
export interface ModeSetRequestSubMessage {
  type: 'mode_set_request';
  mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  from: string;
}

/**
 * idle_notification 子消息 schema（teammate idle 时写到 lead inbox 的实证消息——
 * 实证：reviewer-codex 完成 Round 1 后写到 team-lead.json 的 entry #2 type='idle_notification'
 * + from='reviewer-codex'）。CLI 协议 schema 未公开，按实测字段最小定义。
 *
 * 用途：inbox-watcher 用此识别「teammate 已 idle / 不再响应任何 pending permission」，
 * 把该 teammate 名下所有 active permission emit team-permission-cancelled。
 */
export interface IdleNotificationSubMessage {
  type: 'idle_notification';
  /** 哪个 teammate idle 了（与 InboxEntry.from 一致即可） */
  from: string;
  timestamp?: string;
}

/** 解析 InboxEntry.text 为子消息（任一已知 type）。失败返回 null（不抛错）。 */
export function parseSubMessage(
  text: string,
):
  | PermissionRequestSubMessage
  | PermissionResponseSubMessage
  | ModeSetRequestSubMessage
  | IdleNotificationSubMessage
  | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const t = (parsed as { type?: unknown }).type;
  if (t === 'permission_request') {
    const p = parsed as Record<string, unknown>;
    // REVIEW_17 R2 / L1-R2：request_id / tool_name 必须非空字符串。typeof '' === 'string'
    // 否则空串通过校验 → inbox-watcher 用 '' 当 dedup key → 后续所有 request_id='' 的
    // 条目静默跳过（CLI 实际生成 UUID 不会触发，但损坏 / 手工编辑 inbox 时会）。
    if (typeof p.request_id !== 'string' || p.request_id.length === 0) return null;
    if (typeof p.tool_name !== 'string' || p.tool_name.length === 0) return null;
    return p as unknown as PermissionRequestSubMessage;
  }
  if (t === 'permission_response') {
    const p = parsed as Record<string, unknown>;
    if (typeof p.request_id !== 'string' || p.request_id.length === 0) return null;
    return p as unknown as PermissionResponseSubMessage;
  }
  if (t === 'mode_set_request') {
    const p = parsed as Record<string, unknown>;
    if (typeof p.mode !== 'string') return null;
    return p as unknown as ModeSetRequestSubMessage;
  }
  if (t === 'idle_notification') {
    const p = parsed as Record<string, unknown>;
    if (typeof p.from !== 'string') return null;
    return p as unknown as IdleNotificationSubMessage;
  }
  return null;
}

/** 锁选项（与 CLI 内 `O9_` 常量完全一致）。 */
const LOCK_OPTIONS = {
  retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
  // realpath:false：proper-lockfile 默认会 realpath 文件，但 inbox 文件可能还不存在
  // （首次写时还没 file），realpath 会抛 ENOENT。CLI 内部对部分 inbox 操作也设了 realpath:false
  // （strings 出 GY5={realpath:!1,...}），与之对齐。
  realpath: false,
} as const;

/**
 * 读 inbox 文件全文（数组形式）。文件不存在 / parse 失败 → 返回 []（不抛错）。
 *
 * **不加锁**：纯读，调用方按需自己加锁包外层（如果写完立刻读避免读到旧版）。
 */
export async function readInboxFile(filepath: string): Promise<InboxEntry[]> {
  if (!existsSync(filepath)) return [];
  try {
    const text = await readFile(filepath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is InboxEntry =>
        e !== null &&
        typeof e === 'object' &&
        typeof (e as InboxEntry).from === 'string' &&
        typeof (e as InboxEntry).text === 'string' &&
        typeof (e as InboxEntry).timestamp === 'string',
    );
  } catch (err) {
    console.warn(`[inbox-protocol] readInboxFile parse failed @ ${filepath}:`, err);
    return [];
  }
}

/**
 * 往一个成员的 inbox 文件追加一条消息（带 proper-lockfile 锁，与 CLI 同协议）。
 *
 * 如果目录或文件不存在会自动创建（mkdir -p + 默认 []）。
 * 写入用 tmp + rename 原子操作，避免崩溃留下半截 JSON。
 *
 * @param teamName  目标 team 名（会被 slugify）
 * @param recipient 接收方 agent_id（会被 slugify，如 "reviewer-codex"）
 * @param sub       子消息（会 JSON.stringify 后塞进 text 字段）
 * @param fromAgentId 谁发的（默认 "team-lead"）
 * @param color     UI 颜色提示（可选）
 */
export async function appendInboxMessage(
  teamName: string,
  recipient: string,
  sub: PermissionResponseSubMessage | ModeSetRequestSubMessage,
  opts: { fromAgentId?: string; color?: string } = {},
): Promise<void> {
  const filepath = getInboxPath(teamName, recipient);
  const lockfile = `${filepath}.lock`;
  const dir = dirname(filepath);

  // 确保目录存在（首次写 inbox 时常见）
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  // 文件不存在则先建空 `[]`，proper-lockfile 才能 lock 住一个真实文件
  // （即便 realpath:false，stale check 仍要求 target 存在）
  if (!existsSync(filepath)) {
    await writeFile(filepath, '[]\n', 'utf8');
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lock(filepath, { ...LOCK_OPTIONS, lockfilePath: lockfile });
    const current = await readInboxFile(filepath);
    const entry: InboxEntry = {
      from: opts.fromAgentId ?? 'team-lead',
      text: JSON.stringify(sub),
      timestamp: new Date().toISOString(),
      ...(opts.color ? { color: opts.color } : {}),
      read: false,
    };
    current.push(entry);

    // 原子写：tmp + rename
    const tmp = `${filepath}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8');
    await rename(tmp, filepath);
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        console.warn(`[inbox-protocol] release lock failed @ ${lockfile}:`, err);
      }
    }
  }
}

/** 标准 permission_response 构造器（写入 teammate inbox 用）。 */
export function buildPermissionResponse(
  requestId: string,
  decision: 'allow' | 'deny',
  opts: { updatedInput?: Record<string, unknown>; reason?: string } = {},
): PermissionResponseSubMessage {
  if (decision === 'allow') {
    return {
      type: 'permission_response',
      request_id: requestId,
      subtype: 'success',
      response: {
        updated_input: opts.updatedInput ?? {},
        permission_updates: [],
      },
    };
  }
  return {
    type: 'permission_response',
    request_id: requestId,
    subtype: 'error',
    error: opts.reason ?? '用户已拒绝',
  };
}
